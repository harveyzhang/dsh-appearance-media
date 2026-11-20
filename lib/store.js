// dsh-appearance-media — the store.
//
// TWO FILES LIVE IN THE DATA DIRECTORY, AND THEY SHARE ONE WRITE QUEUE:
//
//   * `<dataDir>/media/.meta.json` — the LEDGER: what the Host knows about
//     the media library beyond what the directory itself says;
//   * `<dataDir>/config.json`      — the SLOT CONFIGURATION: which material
//     each of the three slots plays, whether it is on, and its options.
//
// ★ THE QUEUE IS PER DATA DIRECTORY, NOT PER FILE, AND THAT IS THE POINT.
//
//   Task 2 shipped a queue that was ledger-only. The slot configuration is a
//   DIFFERENT file in the SAME directory. Two queues would be two sources of
//   truth again: "the library changed" and "the configuration changed" would
//   be able to interleave into a lost update. So there is ONE queue, keyed by
//   the data directory, and it serialises EVERY write into that directory —
//   the ledger's writes included.
//
// ★ THE QUEUE IS IN-PROCESS ONLY.
//
//   Two Host processes on the same profile have two queues. That is a known
//   limit, not an oversight: the Host's own configuration editor is a
//   whole-file rewrite with no cross-process lock either.
//
// ★ THE REVISION IS NOT THE HOST'S TO INCREMENT.
//
//   The Host increments NOTHING on a plugin's behalf — a volatile config field
//   is only ever what a human typed into a form. So the slot configuration
//   carries its own revision, in `<dataDir>/config.json`, and the store
//   increments it.
//
// ★ TWO REVISIONS, TWO MEANINGS, AND THEY ARE NOT THE SAME NUMBER.
//
//   * the WHOLE revision — "the configuration changed". It moves by one on
//     every write.
//   * the PER-SLOT revision — "this ONE surface needs to be applied again". It
//     moves only when THAT slot's `enabled` or `mediaId` changed.
//
//   Changing only `options` moves the whole revision and NONE of the slot
//   revisions: the surfaces do not have to be re-applied, but the settings
//   page does have to refresh.
//
// WHY A LEDGER AT ALL, WHEN THE DIRECTORY ALREADY SAYS SOMETHING:
//
//   1. THE ID MUST MATCH THE FILE NAME. An uploaded file is stored as
//      `up-<sha12><ext>`, and its id is `up-<sha12>` — the file name MINUS the
//      extension. A scan that rebuilt the id from the file name would produce
//      `fs-…` for an uploaded file, and then the id the upload route answered
//      with would not be the id the catalog lists, and `GET /media/<id>` would
//      404. That mismatch is invisible to every assertion except the one that
//      compares the two ids.
//
//   2. THE REVISION NEEDS A HOME. The catalog's `revision` is what a browser
//      (and, later, the slot controller) compares to decide "did the library
//      change?". The Host increments NOTHING on a plugin's behalf — a volatile
//      config field is only ever what a human typed into a form. So the
//      revision lives here, and it moves when the ledger is written.
//
// Node built-ins only.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { configPath, mediaDir } from './paths.js'

/** The ledger's file name, inside the media directory. */
export const LEDGER_FILENAME = '.meta.json'

/** The slot configuration's temporary file, next to the configuration itself. */
export const CONFIG_TEMP_FILENAME = 'config.json.tmp'

/** The three slots, in the order the browser half reads them. */
export const SLOT_NAMES = ['background', 'boot', 'screensaver']

/** The write queues, keyed by the absolute data directory. */
const queues = new Map()

/**
 * The shape of the option groups, and the default of every field in them.
 *
 * ONE TABLE, USED TWICE: to fill the gaps in an old file, and to validate a
 * patch. A field that is not in this table is not an option — it is an unknown
 * key, and it is reported as ignored.
 */
const OPTION_SHAPE = {
  background: {
    // The opacity of the mask over the background: 0 = fully transparent
    // (only the background shows), 1 = fully covered.
    surface: { type: 'number', min: 0, max: 1, default: 0 },
    // ★ HOW OPAQUE THE APPLICATION'S PANELS ARE OVER THE MEDIA.
    //
    // This is a SEPARATE knob from `surface`, and it has to be:
    //   `surface` dims the media itself (a veil over the video);
    //   `panel` decides how much of the media shows through the panels.
    //
    // ★ 0.86 IS THE DEFAULT BECAUSE A MOVING PICTURE UNDER TEXT IS HARD TO
    // READ. The panels are the application's own surfaces — the sidebar, the
    // conversation area, the input box — and the user reads text on them.
    // At a lower value the media shines through the text and the interface
    // becomes tiring to look at, which is exactly the complaint that came
    // out of the first real-machine test.
    //
    // The value is the ALPHA of the panel colour: 1 = fully opaque,
    // 0.86 = the media is a faint tint behind the text.
    panel: { type: 'number', min: 0.3, max: 1, default: 0.78 },
    // Muted by default: a background video with sound is blocked by the
    // browser's autoplay policy anyway, and a silent background is the
    // expected behaviour.
    muted: { type: 'boolean', default: true },
    // Pause the background while the page is hidden.
    pauseWhenHidden: { type: 'boolean', default: true },
  },
  boot: {
    muted: { type: 'boolean', default: true },
    // How long the boot clip fades in and out, in milliseconds. The boot
    // clip has to fade: it is the first thing the user sees, and a hard cut
    // looks like a glitch.
    fadeMs: { type: 'number', min: 0, max: 5000, default: 2000 },
    // The budget for the kernel to become ready, in milliseconds. The boot
    // clip stays at least this long, even when it ends earlier: the user
    // needs a beat to see the animation.
    holdMs: { type: 'number', min: 0, max: 60000, default: 15000 },
    // ★ HOW THE BOOT SCREEN HANDS OVER TO THE APPLICATION.
    //
    //   'tail'  the hand-over happens over the clip's last fade, so the two
    //            finish together;
    //   'end'   the clip plays out and the application fades in afterwards;
    //   'click' the screen never enters on its own and waits for a click.
    //
    // An unknown value falls back to 'tail'.
    enterMode: { type: 'enum', values: ['tail', 'end', 'click'], default: 'tail' },
    // ★ WHERE THE BOOT CLIP COMES FROM.
    //
    //   'media' the one material the slot names;
    //   'pool'  a random material out of the library, every time.
    source: { type: 'enum', values: ['media', 'pool'], default: 'media' },
    // ★ THE POOL THE RANDOM PICK IS MADE FROM.
    //
    // An empty list means "the whole library" — which is what the pool mode
    // did before the pool could be narrowed. A list of material ids means
    // "only these, and the pick is random among them".
    pool: { type: 'ids', max: 64, default: [] },
  },
  screensaver: {
    // Five minutes of idleness before the screensaver takes over.
    idleMs: { type: 'number', min: 30000, max: 3600000, default: 300000 },
    volume: { type: 'number', min: 0, max: 1, default: 0 },
    muted: { type: 'boolean', default: true },
    // The break-away effect: the screensaver shatters instead of just
    // fading when the user comes back.
    breakEffect: { type: 'boolean', default: true },
    // The pointer effect: something follows the pointer while the screensaver
    // is up.
    pointerEffect: { type: 'boolean', default: false },
    // ★ WHICH break effect, when `breakEffect` is on. It is a second field
    // rather than a second spelling of the first: one answers "whether",
    // the other answers "which".
    breakStyle: { type: 'enum', values: ['particles', 'fall', 'glitch'], default: 'particles' },
    // ★ WHICH pointer effect, when `pointerEffect` is on.
    pointerStyle: { type: 'enum', values: ['ripples', 'attract'], default: 'ripples' },
    // The hint that tells the user how to get rid of the screensaver.
    hint: { type: 'boolean', default: true },
    // How long one clip stays on the screen before the next one takes over.
    // 0 = no rotation.
    rotateMs: { type: 'number', min: 0, max: 600000, default: 0 },
  },
}

/**
 * A rejected configuration change.
 *
 * The route answers 400 for this and 500 for anything else, so the difference
 * between "the client sent something impossible" and "the disk is broken" has
 * to survive all the way to the response.
 */
export class ConfigError extends Error {
  /**
   * @param message - the Chinese sentence for the client.
   * @param status - the HTTP status the route should answer.
   */
  constructor(message, status = 400) {
    super(message)
    this.name = 'ConfigError'
    this.status = status
  }
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
 * Whether a value is a finite number.
 *
 * @param value - the value.
 * @returns true when it is a number and not NaN or Infinity.
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The absolute path of the ledger.
 *
 * @param dataDir - an absolute data directory.
 * @returns the absolute ledger path.
 */
export function ledgerPath(dataDir) {
  return path.join(mediaDir(dataDir), LEDGER_FILENAME)
}

/**
 * Read the ledger.
 *
 * READ EVERY TIME, NEVER CACHED: the catalog route is asked for the revision on
 * every request, and a cached revision is a revision that lies. A missing
 * ledger is an empty ledger (revision 0) — the library simply has not been
 * written to yet, and that is not an error.
 *
 * A ledger that cannot be parsed is reported and treated as empty: the
 * directory scan does not depend on the ledger (only the upload metadata and
 * the revision do), so one corrupt file must not take the whole catalog down.
 *
 * @param dataDir - an absolute data directory.
 * @returns `{ revision, entries }`.
 */
export function readLedger(dataDir) {
  const empty = { revision: 0, entries: {} }
  let text
  try {
    text = readFileSync(ledgerPath(dataDir), 'utf8')
  } catch {
    return empty
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.warn('[dsh-appearance-media] 账本无法解析，按空账本继续：' + String(error))
    return empty
  }
  const revision = Number.isFinite(parsed?.revision) ? Number(parsed.revision) : 0
  const entries = parsed?.entries !== null && typeof parsed?.entries === 'object'
    ? parsed.entries
    : {}
  return { revision, entries }
}

/**
 * The ledger's revision, read now.
 *
 * @param dataDir - an absolute data directory.
 * @returns the revision, 0 when there is no ledger yet.
 */
export function ledgerRevision(dataDir) {
  return readLedger(dataDir).revision
}

/**
 * Run one task in the queue of its data directory.
 *
 * ★ THIS IS THE ONE QUEUE. Every write into a data directory — the ledger's
 * and the configuration's — goes through it, so a "read-modify-write" can
 * never interleave with another one.
 *
 * The stored chain swallows failures: one failed write must not poison every
 * write that follows it. The caller still sees its own rejection.
 *
 * @param dataDir - an absolute data directory.
 * @param task - the work to do.
 * @returns a promise for the task's result.
 */
export function enqueue(dataDir, task) {
  const key = path.resolve(dataDir)
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(() => task())
  queues.set(key, run.then(() => undefined, () => undefined))
  return run
}

/**
 * Write the ledger, through the queue.
 *
 * The mutator receives a COPY of the current entries and returns the entries to
 * store (or mutates the copy in place and returns nothing). The revision is
 * incremented by exactly one per write — that is what "the library changed"
 * means to a browser.
 *
 * @param dataDir - an absolute data directory.
 * @param mutate - `(entries, current) => entries | void | Promise<entries | void>`.
 * @returns a promise for `{ revision, entries }`.
 */
export function updateLedger(dataDir, mutate) {
  return enqueue(dataDir, () => writeLedgerOnce(path.resolve(dataDir), mutate))
}

/**
 * One queued ledger write.
 *
 * @param dataDir - an absolute data directory.
 * @param mutate - the mutator.
 * @returns a promise for the written ledger.
 */
async function writeLedgerOnce(dataDir, mutate) {
  const current = readLedger(dataDir)
  const draft = { ...current.entries }
  const returned = await mutate(draft, current)
  const entries = returned !== undefined && returned !== null ? returned : draft
  const ledger = { revision: current.revision + 1, entries }

  const dir = mediaDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const target = ledgerPath(dataDir)
  // The temporary file is written and then RENAMED: a reader either sees the
  // old file or the new one, never half of one.
  const temp = path.join(dir, `.meta-${String(process.pid)}-${String(Date.now())}.tmp`)
  writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
  try {
    renameSync(temp, target)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* the temporary file is already gone */
    }
    throw error
  }
  return ledger
}

/**
 * The default slot configuration.
 *
 * Three disabled slots with no material, and the option defaults from the
 * table above. A missing file means exactly this — the configuration has not
 * been written yet.
 *
 * @returns the default configuration.
 */
export function defaultConfig() {
  const slots = {}
  for (const name of SLOT_NAMES) {
    slots[name] = { enabled: false, mediaId: null, revision: 0 }
  }
  const options = {}
  for (const [group, fields] of Object.entries(OPTION_SHAPE)) {
    const values = {}
    for (const [field, spec] of Object.entries(fields)) {
      values[field] = spec.default
    }
    options[group] = values
  }
  return { revision: 0, slots, options }
}

/**
 * Read the raw configuration document, exactly as it is on disk.
 *
 * @param dataDir - an absolute data directory.
 * @returns the parsed document, or null when there is none or it is broken.
 */
function readRawConfig(dataDir) {
  let text
  try {
    text = readFileSync(configPath(dataDir), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch (error) {
    console.warn('[dsh-appearance-media] 槽位配置无法解析，按默认配置继续：' + String(error))
    return null
  }
}

/**
 * Fold a raw document into the effective configuration.
 *
 * A missing key is filled from the defaults — an old configuration file must
 * not stop the plugin from starting. A key this version does not know is
 * IGNORED and REPORTED: the frontend adding a field must not crash an older
 * plugin.
 *
 * @param raw - the parsed document.
 * @returns `{ config, ignored }`.
 */
function normalizeConfig(raw) {
  const config = defaultConfig()
  const ignored = []

  for (const key of Object.keys(raw)) {
    if (key === 'revision' || key === 'slots' || key === 'options') continue
    ignored.push(key)
  }
  if (isNumber(raw.revision)) config.revision = Math.max(0, Math.trunc(raw.revision))

  const rawSlots = isPlainObject(raw.slots) ? raw.slots : {}
  for (const name of Object.keys(rawSlots)) {
    if (!SLOT_NAMES.includes(name)) {
      ignored.push('slots.' + name)
      continue
    }
    const rawSlot = isPlainObject(rawSlots[name]) ? rawSlots[name] : {}
    for (const key of Object.keys(rawSlot)) {
      if (key !== 'enabled' && key !== 'mediaId' && key !== 'revision') {
        ignored.push('slots.' + name + '.' + key)
      }
    }
    if (typeof rawSlot.enabled === 'boolean') config.slots[name].enabled = rawSlot.enabled
    if (rawSlot.mediaId === null || (typeof rawSlot.mediaId === 'string' && rawSlot.mediaId !== '')) {
      config.slots[name].mediaId = rawSlot.mediaId
    }
    if (isNumber(rawSlot.revision)) {
      config.slots[name].revision = Math.max(0, Math.trunc(rawSlot.revision))
    }
  }

  const rawOptions = isPlainObject(raw.options) ? raw.options : {}
  for (const group of Object.keys(rawOptions)) {
    const shape = OPTION_SHAPE[group]
    if (shape === undefined) {
      ignored.push('options.' + group)
      continue
    }
    const rawGroup = isPlainObject(rawOptions[group]) ? rawOptions[group] : {}
    for (const field of Object.keys(rawGroup)) {
      const spec = shape[field]
      if (spec === undefined) {
        ignored.push('options.' + group + '.' + field)
        continue
      }
      const value = rawGroup[field]
      if (spec.type === 'number') {
        if (!isNumber(value)) continue
        if (value < spec.min || value > spec.max) continue
        config.options[group][field] = value
      } else if (spec.type === 'ids') {
        // ★ A LIST OF MATERIAL IDS. A value that is not a list is not a
        // list, and a list with something that is not an id in it is not a
        // list of ids either — so it is dropped, and the field keeps its
        // default.
        if (!Array.isArray(value)) continue
        const ids = []
        for (const item of value) {
          if (typeof item !== 'string') continue
          const id = item.trim()
          if (id === '') continue
          if (ids.includes(id)) continue
          ids.push(id)
          if (ids.length >= (spec.max || 64)) break
        }
        config.options[group][field] = ids
      } else if (spec.type === 'enum') {
        // ★ AN ENUM IS ACCEPTED ONLY IF IT IS ONE OF THE DECLARED VALUES.
        // A value the shape does not know is not "close enough" — it is a
        // different option, and storing it would put the page into a state
        // the card cannot show.
        if (typeof value !== 'string') continue
        if (!spec.values.includes(value)) continue
        config.options[group][field] = value
      } else if (typeof value === 'boolean') {
        config.options[group][field] = value
      }
    }
  }

  return { config, ignored }
}

/**
 * Read the slot configuration.
 *
 * ★ A MISSING DIRECTORY OR A MISSING FILE IS NOT AN ERROR: the answer is the
 * default configuration, and nothing is created. The first
 * `GET /appearance-media/slots` on a fresh profile answers 200 with three
 * disabled slots — never 500.
 *
 * READ EVERY TIME, NEVER CACHED: a cached configuration is a configuration
 * that lies, and "immediately effective" is the whole point of this file.
 *
 * @param dataDir - an absolute data directory.
 * @returns `{ config, ignored }`.
 */
export function readConfig(dataDir) {
  const raw = readRawConfig(dataDir)
  if (raw === null) return { config: defaultConfig(), ignored: [] }
  return normalizeConfig(raw)
}

/**
 * Validate one option value.
 *
 * @param spec - the field's specification.
 * @param value - the value from the patch.
 * @param label - the field's path, for the error message.
 * @returns the value.
 * @throws ConfigError when the value does not fit.
 */
function validateOption(spec, value, label) {
  if (spec.type === 'number') {
    if (!isNumber(value)) throw new ConfigError(label + ' 必须是数字。')
    if (value < spec.min || value > spec.max) {
      throw new ConfigError(label + ' 必须在 ' + String(spec.min) + ' 与 ' + String(spec.max) + ' 之间。')
    }
    return value
  }
  if (spec.type === 'ids') {
    if (!Array.isArray(value)) throw new ConfigError(label + ' 必须是数组。')
    const ids = []
    for (const item of value) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new ConfigError(label + ' 里必须是非空字符串。')
      }
      const id = item.trim()
      if (ids.includes(id)) continue
      ids.push(id)
    }
    if (ids.length > (spec.max || 64)) throw new ConfigError(label + ' 最多 ' + String(spec.max || 64) + ' 项。')
    return ids
  }
  if (spec.type === 'enum') {
    if (typeof value !== 'string') throw new ConfigError(label + ' 必须是字符串。')
    if (!spec.values.includes(value)) {
      throw new ConfigError(label + ' 只能是 ' + spec.values.join(' / ') + ' 之一。')
    }
    return value
  }
  if (typeof value !== 'boolean') throw new ConfigError(label + ' 必须是布尔值。')
  return value
}

/**
 * Write the slot configuration, through the queue.
 *
 * THE PATCH SHAPE, and it is flat:
 *
 *   { "slot": "background", "enabled": true, "mediaId": "up-…" }
 *   { "options": { "screensaver": { "idleMs": 600000 } } }
 *
 * `slot` names the slot `enabled` and `mediaId` belong to; `options` is
 * global. A key this version does not know is ignored and reported in
 * `ignored` — it never fails the write and never changes another field.
 *
 * `mediaId: null` is legal: it clears that slot's choice.
 *
 * @param dataDir - an absolute data directory.
 * @param patch - the patch.
 * @returns a promise for `{ config, ignored }`, where `config` is the merged
 *   configuration with its new revision.
 * @throws ConfigError when the patch is impossible — and NOTHING is written.
 */
export function writeConfig(dataDir, patch) {
  return enqueue(dataDir, () => writeConfigOnce(path.resolve(dataDir), patch))
}

/**
 * One queued configuration write.
 *
 * @param dataDir - an absolute data directory.
 * @param patch - the patch.
 * @returns a promise for `{ config, ignored }`.
 */
async function writeConfigOnce(dataDir, patch) {
  const source = isPlainObject(patch) ? patch : {}
  const current = readConfig(dataDir)
  const ignored = [...current.ignored]

  // ── The patch, validated. NOTHING is written until all of it passes. ──
  let slotName = null
  if (Object.prototype.hasOwnProperty.call(source, 'slot')) {
    if (typeof source.slot !== 'string' || !SLOT_NAMES.includes(source.slot)) {
      throw new ConfigError('slot 必须是 ' + SLOT_NAMES.join(' / ') + ' 之一。')
    }
    slotName = source.slot
  }

  let enabled
  const hasEnabled = Object.prototype.hasOwnProperty.call(source, 'enabled')
  if (hasEnabled) {
    if (typeof source.enabled !== 'boolean') throw new ConfigError('enabled 必须是布尔值。')
    enabled = source.enabled
  }

  const hasMediaId = Object.prototype.hasOwnProperty.call(source, 'mediaId')
  let mediaId = null
  if (hasMediaId) {
    const value = source.mediaId
    if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
      throw new ConfigError('mediaId 必须是非空字符串或 null。')
    }
    mediaId = value
  }

  if ((hasEnabled || hasMediaId) && slotName === null) {
    throw new ConfigError('改 enabled 或 mediaId 的时候必须先说 slot 是哪一个。')
  }

  const optionPatch = {}
  if (Object.prototype.hasOwnProperty.call(source, 'options')) {
    if (!isPlainObject(source.options)) throw new ConfigError('options 必须是对象。')
    for (const [group, value] of Object.entries(source.options)) {
      const shape = OPTION_SHAPE[group]
      if (shape === undefined) {
        ignored.push('options.' + group)
        continue
      }
      if (!isPlainObject(value)) throw new ConfigError('options.' + group + ' 必须是对象。')
      const fields = {}
      for (const [field, fieldValue] of Object.entries(value)) {
        const spec = shape[field]
        if (spec === undefined) {
          ignored.push('options.' + group + '.' + field)
          continue
        }
        fields[field] = validateOption(spec, fieldValue, 'options.' + group + '.' + field)
      }
      optionPatch[group] = fields
    }
  }

  for (const key of Object.keys(source)) {
    if (key === 'slot' || key === 'enabled' || key === 'mediaId' || key === 'options') continue
    ignored.push(key)
  }

  // ── The merge. ──
  const next = defaultConfig()
  next.revision = current.config.revision + 1
  for (const name of SLOT_NAMES) {
    next.slots[name] = { ...current.config.slots[name] }
  }
  for (const group of Object.keys(OPTION_SHAPE)) {
    next.options[group] = { ...current.config.options[group] }
  }

  if (slotName !== null) {
    const slot = next.slots[slotName]
    const beforeEnabled = slot.enabled
    const beforeMediaId = slot.mediaId
    if (hasEnabled) slot.enabled = enabled
    if (hasMediaId) slot.mediaId = mediaId
    // ★ THE SLOT REVISION MOVES ONLY WHEN THAT SLOT'S CONTENT CHANGED.
    // Changing `options` alone moves the whole revision and leaves every slot
    // revision alone: the surfaces do not have to be applied again.
    if (slot.enabled !== beforeEnabled || slot.mediaId !== beforeMediaId) {
      slot.revision = slot.revision + 1
    }
  }

  for (const [group, fields] of Object.entries(optionPatch)) {
    Object.assign(next.options[group], fields)
  }

  // ── The write, atomic. ──
  const raw = readRawConfig(dataDir)
  const document = {
    ...(raw ?? {}),
    revision: next.revision,
    slots: { ...(isPlainObject(raw?.slots) ? raw.slots : {}), ...next.slots },
    options: { ...(isPlainObject(raw?.options) ? raw.options : {}), ...next.options },
  }
  writeAtomic(
    configPath(dataDir),
    JSON.stringify(document, null, 2) + '\n',
    path.join(dataDir, CONFIG_TEMP_FILENAME),
  )

  return { config: next, ignored: [...new Set(ignored)] }
}

/**
 * Write one file atomically.
 *
 * A temporary file, an fsync, and then a rename. A reader either sees the old
 * file or the new one, never half of one — a configuration file that is half
 * written is a configuration the plugin can never read again.
 *
 * @param target - the file to write.
 * @param text - the content.
 * @param temp - the temporary file to write first.
 */
function writeAtomic(target, text, temp) {
  mkdirSync(path.dirname(target), { recursive: true })
  const fd = openSync(temp, 'w')
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, target)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* the temporary file is already gone */
    }
    throw error
  }
}
