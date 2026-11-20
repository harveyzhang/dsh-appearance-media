// Lossless `moov`-to-front rewrite, in process.
//
// ───────────────────────────────────────────────────────────────────────────
// PORTED FROM dsh-boot-animation (P05) — MIT licensed.
//
//   Copyright (c) 2026 dsh-boot-animation contributors
//   https://github.com/lxj5820/dsh-boot-animation
//
// The copyright notice above is upstream's and is kept VERBATIM, as the licence
// requires. The implementation below is upstream's too, copied rather than
// reimplemented — INCLUDING ITS REFUSAL RULES, because those rules are what
// the tool's own suite proved on real clips: equal length, the media payload
// bit-identical after `moov` is stripped out, the chunk-offset tables shifted
// by exactly the layout's shift, and the result asserted to actually place
// `moov` before `mdat` (checking the OUTPUT, not the plan — a plan that leaves
// `moov` where it was passes every other proof, which is how this tool once
// wrote byte-identical copies and reported success).
//
// ★ WHY THIS FILE IS IN `lib/` HERE, WHEN UPSTREAM PUTS IT IN `src/`.
//
//   Upstream's `lib/` is build output — `lib/client.js` is the built browser
//   half — so a hand-written module does not belong beside it, and upstream
//   puts this one in `src/`. THIS package's convention is the other way round:
//   `lib/` is where the hand-written Host-side modules live (`catalog.js`,
//   `paths.js`, `probe.js`, `store.js`, `upload.js`), and only `lib/client.js`
//   is a build artifact. So the module is ported into `lib/remux.js`, and
//   `src/` stays the browser half plus the shared modules.
//
// ★ WHAT CHANGED IN THE PORT. Two things, and nothing else.
//
//   1. The directory convention above.
//
//   2. THE SWAP. Upstream's `optimizeInPlace` moves the original aside into a
//      backup directory and then renames the rewritten file into its place.
//      That leaves a window — two `rename(2)` calls wide — in which the file's
//      own path holds NO file at all, and a crash inside that window takes the
//      clip out of the library. Here the original STAYS where it is until the
//      rewritten file is renamed OVER it: one atomic `rename(2)`, so a reader
//      sees the old clip or the new one and never neither. The rescue copy
//      that makes the rollback possible is TRANSIENT — it lives in the
//      staging directory and goes away with it — so a successful optimization
//      leaves no second copy of the user's material behind. Upstream's
//      `backupDir` option still works, and still holds a COPY rather than a
//      rename, for a caller that wants the original kept.
//
//   The refusal rules are NOT changed. Every one of them is still here, in the
//   same order, for the same reasons.
//
// ★ NOTHING HERE RUNS UNLESS A CALLER ASKS FOR IT. The plugin never rewrites a
//   clip on its own.
//
// Node built-ins only.

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/**
 * Ceiling for an in-place rewrite, in bytes.
 *
 * Not a technical limit: `remux` holds the whole file in memory and then builds a
 * second buffer of the same size, so the peak cost is about twice the clip. 100MB
 * keeps that bounded in a process that is also serving the UI. A clip above this
 * keeps its badge and is left alone.
 */
export const MAX_OPTIMIZE_BYTES = 100 * 1024 * 1024

/** A refusal the route reports as a plain sentence rather than a crash. */
function refusal(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Walk the top-level box list of an mp4.
 * @param buffer - whole file.
 * @returns boxes in file order.
 */
function topLevelBoxes(buffer) {
  const boxes = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      // 64-bit size: the real length follows the type.
      if (offset + 16 > buffer.length) break
      const high = buffer.readUInt32BE(offset + 8)
      const low = buffer.readUInt32BE(offset + 12)
      size = high * 2 ** 32 + low
      header = 16
    } else if (size === 0) {
      // Extends to end of file.
      size = buffer.length - offset
    }
    if (size < header || offset + size > buffer.length) {
      throw new Error(`malformed box ${type} at ${String(offset)} (size ${String(size)})`)
    }
    boxes.push({ type, start: offset, size, header, payload: offset + header })
    offset += size
  }
  if (offset !== buffer.length) {
    throw new Error(`trailing bytes: parsed ${String(offset)} of ${String(buffer.length)}`)
  }
  return boxes
}

/**
 * Locate every chunk-offset table inside the movie box.
 *
 * The scan is confined to `moov` because `stco` as a byte sequence can also occur
 * inside compressed `mdat` payload by chance; restricting it and then checking
 * that the box length matches its own entry count makes a false positive
 * essentially impossible.
 *
 * @param moov - the movie box bytes.
 * @returns absolute offsets (into the original file) of each table's payload.
 */
function chunkOffsetTables(moov) {
  const tables = []
  const needle = Buffer.from('stco', 'latin1')
  const wide = Buffer.from('co64', 'latin1')
  for (const [marker, width] of [[needle, 4], [wide, 8]]) {
    for (let at = moov.indexOf(marker); at >= 0; at = moov.indexOf(marker, at + 1)) {
      const sizeAt = at - 4
      if (sizeAt < 0) continue
      const declared = moov.readUInt32BE(sizeAt)
      if (at + 8 > moov.length) continue
      const count = moov.readUInt32BE(at + 8)
      if (declared !== 16 + width * count) continue
      if (sizeAt + declared > moov.length) continue
      tables.push({ type: marker.toString('latin1'), dataAt: at + 12, count, width })
    }
  }
  return tables
}

/**
 * Decide the new top-level order and the byte shift applied to chunk offsets.
 * @param boxes - parsed top-level boxes.
 * @returns the planned layout.
 */
function plan(boxes) {
  const moovAt = boxes.findIndex(box => box.type === 'moov')
  if (moovAt < 0) throw new Error('no moov box')
  const moov = boxes[moovAt]
  const mdatCount = boxes.filter(box => box.type === 'mdat').length
  if (mdatCount > 1) throw new Error('multiple mdat boxes are not supported')
  const moovIsFirst = moovAt === 0 || boxes.slice(0, moovAt).every(box => box.type !== 'mdat')
  if (moovIsFirst) return { already: true }

  // `moov` goes immediately after the first box (`ftyp`), which puts it in front
  // of `mdat` — that is the entire point. See the module header for what the first
  // version got wrong.
  const withoutMoov = boxes.filter(box => box !== moov)
  const insertAt = withoutMoov.findIndex(box => box.type === 'ftyp') + 1
  const ordered = [
    ...withoutMoov.slice(0, insertAt),
    moov,
    ...withoutMoov.slice(insertAt),
  ]
  const mdatAt = ordered.findIndex(box => box.type === 'mdat')
  const moovOrder = ordered.findIndex(box => box.type === 'moov')
  if (mdatAt >= 0 && moovOrder > mdatAt) {
    throw new Error('planned layout leaves moov after mdat; refusing to write')
  }

  let cursor = 0
  const placed = new Map()
  for (const box of ordered) {
    placed.set(box, cursor)
    cursor += box.size
  }
  if (cursor !== boxes.reduce((sum, box) => sum + box.size, 0)) {
    throw new Error('layout does not conserve length')
  }
  const mdat = boxes.find(box => box.type === 'mdat')
  const shift = (placed.get(mdat) + mdat.header) - mdat.payload
  if (mdat !== undefined && shift <= 0) {
    throw new Error(`moov would not move (shift ${String(shift)}); refusing to write`)
  }
  return { already: false, moov, ordered, placed, shift, mdat }
}

/** Apply a byte shift to every entry of every chunk-offset table. */
function patchOffsets(moovBytes, tables, shift) {
  const out = Buffer.from(moovBytes)
  for (const table of tables) {
    for (let index = 0; index < table.count; index += 1) {
      const at = table.dataAt + index * table.width
      if (table.width === 4) {
        const value = out.readUInt32BE(at)
        const moved = value + shift
        if (moved < 0 || moved > 0xffffffff) {
          throw new Error('a 32-bit chunk offset overflowed; the file needs co64, use ffmpeg')
        }
        out.writeUInt32BE(moved, at)
      } else {
        // 64-bit arithmetic all the way, not through a Number: a co64 entry can name
        // an offset above 2^53, which Number cannot represent exactly, and rounding it
        // would corrupt the only index the file has.
        out.writeBigUInt64BE(out.readBigUInt64BE(at) + BigInt(shift), at)
      }
    }
  }
  return out
}

/**
 * Rewrite one file into a staging directory.
 *
 * Same contract as the tool's own `remux`, including that nothing is written
 * unless `writeTo` is literally true — this half always passes true, and the
 * default keeps the "report only" behaviour from becoming an accident.
 * @param file - absolute path to the source clip.
 * @param target - directory the rewritten copy is written into.
 * @param writeTo - false reports without writing.
 * @returns a human-readable result line.
 */
export function remux(file, target, writeTo) {
  const name = basename(file)
  const buffer = readFileSync(file)
  const boxes = topLevelBoxes(buffer)
  const layout = plan(boxes)
  if (layout.already) return `SKIP  ${name}: moov 已在最前，无需处理`

  const moovBytes = buffer.subarray(layout.moov.start, layout.moov.start + layout.moov.size)
  const tables = chunkOffsetTables(moovBytes)
  if (tables.length === 0) throw new Error('no chunk offset table inside moov')
  const patched = patchOffsets(moovBytes, tables, layout.shift)

  const pieces = []
  for (const box of layout.ordered) {
    if (box === layout.moov) pieces.push(patched)
    else pieces.push(buffer.subarray(box.start, box.start + box.size))
  }
  const output = Buffer.concat(pieces)
  if (output.length !== buffer.length) {
    throw new Error(`length changed: ${String(buffer.length)} -> ${String(output.length)}`)
  }

  // Lossless proof: removing `moov` from both files must leave the same bytes.
  const strip = (bytes, boxList) => {
    const parts = boxList.filter(box => box.type !== 'moov')
      .map(box => bytes.subarray(box.start, box.start + box.size))
    return Buffer.concat(parts)
  }
  const before = strip(buffer, boxes)
  const after = strip(output, topLevelBoxes(output))
  if (!before.equals(after)) throw new Error('media payload changed; refusing to write')

  const outBoxes = topLevelBoxes(output)
  const outMoov = outBoxes.findIndex(box => box.type === 'moov')
  const outMdat = outBoxes.findIndex(box => box.type === 'mdat')
  if (outMoov < 0 || (outMdat >= 0 && outMoov > outMdat)) {
    throw new Error('output still places moov after mdat; refusing to write')
  }

  const moovStart = layout.placed.get(layout.moov)
  const newMoov = output.subarray(moovStart, moovStart + patched.length)
  const newTables = chunkOffsetTables(newMoov)
  if (newTables.length !== tables.length) throw new Error('table count changed')
  // The self-check reads each entry at ITS OWN width. This used to read 32 bits out of
  // both sides no matter what `width` said, so every co64 file — 8 bytes per entry — was
  // compared against a value assembled from two neighbouring entries' halves, never
  // matched, and reported `entry N not shifted correctly`. The rewrite itself was fine
  // and the original was restored, so the damage was a FAILED button on exactly the
  // large clips that most need faststart, not a corrupted file.
  //
  // The comparison is done in BigInt on purpose: a co64 offset may legitimately exceed
  // 2^53, where Number silently rounds and a "match" would be a coincidence.
  const shift = BigInt(layout.shift)
  for (let index = 0; index < tables.length; index += 1) {
    const width = tables[index].width
    const oldAt = tables[index].dataAt
    const newAt = newTables[index].dataAt
    for (let entry = 0; entry < tables[index].count; entry += 1) {
      const at = entry * width
      const was = width === 4
        ? BigInt(moovBytes.readUInt32BE(oldAt + at))
        : moovBytes.readBigUInt64BE(oldAt + at)
      const now = width === 4
        ? BigInt(newMoov.readUInt32BE(newAt + at))
        : newMoov.readBigUInt64BE(newAt + at)
      if (now !== was + shift) throw new Error(`entry ${String(entry)} not shifted correctly`)
    }
  }

  const out = join(target, `${basename(name, extname(name))}.faststart.mp4`)
  const KiB = (layout.moov.size / 1024).toFixed(0)
  const shouldWrite = writeTo === true
  if (!shouldWrite) return `TODO  ${name}: moov 在 ${String(layout.moov.start)}，需要前移 ${KiB}KiB（writeTo 为 false，未写）`
  mkdirSync(target, { recursive: true })
  // ★ THE PRODUCED FILE IS ON THE DISK BEFORE IT IS RENAMED INTO PLACE.
  //
  // A `rename(2)` is atomic in the DIRECTORY, not in the data: without the
  // fsync a crash can leave the new name pointing at bytes that never reached
  // the disk. This is the same order the package's own store writes in
  // (`lib/store.js`: temporary file, fsync, rename).
  const fd = openSync(out, 'w')
  try {
    writeFileSync(fd, output)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return `WROTE ${name} -> ${basename(out)}（moov 前移 ${KiB}KiB，${String(tables.length)} 张偏移表已重写）`
}

/**
 * Whether `moov` precedes `mdat` in the leading part of a file.
 *
 * The same 64 KiB window and the same reasoning as the Host half's manifest read:
 * the order of the first two boxes is not the answer, because these clips carry a
 * ~21 KiB `uuid` metadata box before the media data.
 * @param file - absolute path.
 * @returns true when `moov` comes first, false when `mdat` does, undefined when
 *   neither box is inside the window.
 */
export async function leadingBox(file) {
  let handle
  try {
    handle = await open(file, 'r')
    const head = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    let offset = 0
    while (offset + 8 <= bytesRead) {
      const type = head.toString('latin1', offset + 4, offset + 8)
      if (type === 'moov') return true
      if (type === 'mdat') return false
      const size = head.readUInt32BE(offset)
      if (size < 8) break
      offset += size
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * Move one clip's index table to the front, in place.
 *
 * ★ THE SWAP IS ONE ATOMIC RENAME, AND THE ORIGINAL IS NEVER MOVED ASIDE.
 *
 * The rewritten file is written into `scratchDir` first and is verified there —
 * same length, `moov` really in front of `mdat` — and only then is it renamed
 * OVER the original. `scratchDir` therefore has to be on the same filesystem as
 * the file itself; a caller that stages it elsewhere gets a failed rename and
 * an untouched original, which is the safe direction to fail in.
 *
 * A COPY of the original is kept in the staging directory while the swap
 * happens, so a failure AFTER the rename can put the original back. The copy is
 * transient: it goes away with the staging directory, whether the optimization
 * succeeded or failed. Upstream's `backupDir` option still takes a copy of the
 * original for a caller that wants to KEEP it; it is a copy and not a rename,
 * because the original has to stay in place until the atomic swap.
 *
 * @param options - the clip, where the original goes, and where to stage the rewrite.
 * @returns `{ ok: true, status: 'done' }` or `{ ok: true, status: 'already' }`.
 * @throws a refusal carrying an `E_*` code when the clip is unsupported, oversized,
 *   or fails its own self-check (in which case the original is already back).
 */
export async function optimizeInPlace(options) {
  const file = options.file
  const name = basename(file)
  const backupDir = options.backupDir
  const scratchDir = options.scratchDir
  const max = options.maxBytes ?? MAX_OPTIMIZE_BYTES
  const info = statSync(file)

  if (info.size > max) {
    throw refusal('E_TOO_BIG',
      `${name} 有 ${(info.size / 1024 / 1024).toFixed(1)}MB，超过 ${String(Math.round(max / 1024 / 1024))}MB 上限，不处理。`)
  }

  const leading = await leadingBox(file)
  if (leading === true) return { ok: true, status: 'already', name }
  if (leading !== false) {
    throw refusal('E_UNSUPPORTED', `${name} 的文件头里读不到 moov/mdat（可能不是 mp4），不敢动。`)
  }

  const sizeBefore = info.size
  const base = basename(name, extname(name))
  const produced = join(scratchDir, `${base}.faststart.mp4`)
  // The transient rescue copy. It is a COPY and not a rename: the original has
  // to stay where it is until the rewritten file is renamed over it.
  const rescue = join(scratchDir, `.${base}.original`)
  let swapped = false

  try {
    mkdirSync(scratchDir, { recursive: true })
    remux(file, scratchDir, true)
    if (!existsSync(produced)) throw new Error('重排没有产出文件')
    if (statSync(produced).size !== sizeBefore) throw new Error('重排后的长度变了')
    if (await leadingBox(produced) !== true) throw new Error('重排后的文件里 moov 仍在 mdat 之后')

    // The rescue copy, made BEFORE anything is replaced.
    copyFileSync(file, rescue)

    if (typeof backupDir === 'string' && backupDir !== '') {
      mkdirSync(backupDir, { recursive: true })
      const backup = join(backupDir, name)
      if (existsSync(backup)) rmSync(backup, { force: true })
      copyFileSync(file, backup)
    }

    // ★ THE ATOMIC SWAP. One `rename(2)` over the original: a reader sees the
    // old clip or the new one, and never neither.
    renameSync(produced, file)
    swapped = true
    if (await leadingBox(file) !== true) throw new Error('重排后 moov 仍在 mdat 之后')
    if (statSync(file).size !== sizeBefore) throw new Error('重排后长度变了')
  } catch (error) {
    if (swapped) {
      // The rename already happened: put the original back before anything
      // else, or the clip is left in the library in a state nobody asked for.
      try {
        if (existsSync(rescue)) copyFileSync(rescue, file)
      } catch (restoreError) {
        rmSync(scratchDir, { recursive: true, force: true })
        throw refusal('E_FAILED',
          `重排自检没过，而且原片还原也失败了（请看 ${name}）：${error.message} / ${String(restoreError && restoreError.message ? restoreError.message : restoreError)}`)
      }
      rmSync(scratchDir, { recursive: true, force: true })
      throw refusal('E_FAILED', `重排自检没过，已还原原片：${error.message}`)
    }
    rmSync(scratchDir, { recursive: true, force: true })
    if (typeof error.code === 'string' && error.code.startsWith('E_')) throw error
    throw refusal('E_FAILED', `重排失败，原片没动：${error.message}`)
  }

  rmSync(scratchDir, { recursive: true, force: true })
  return { ok: true, status: 'done', name, bytes: sizeBefore }
}
