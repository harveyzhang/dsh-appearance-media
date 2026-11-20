/**
 * verify-handover.mjs — the hand-over rule, pinned down.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The arbitration point brings a slot back after another slot pushed it off
 * the stage. The rule the coordinator set is: "a slot that is enabled and
 * was PUSHED OFF comes back, highest priority first, one at a time".
 *
 * An earlier implementation also treated "a slot that has NEVER been on the
 * stage" as a candidate. That is not the same thing, and it bites: enabling
 * the boot screen halfway through a session (the boot slot is enabled, but
 * the boot overlay has not played in this session) meant that the next
 * release dragged the boot overlay onto the screen in the middle of a
 * conversation — the boot surface registers a resolver, so the arbitration
 * point could indeed fetch the material for it.
 *
 * These checks pin the rule down, and the second one is a NEGATIVE CONTROL:
 * put the old clause back and the check has to fail.
 *
 * Run: node tools/verify-handover.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTROLLER_PATH = join(HERE, '..', 'src', 'controller.js')
const CONTROLLER_TEXT = readFileSync(CONTROLLER_PATH, 'utf8')

let failed = 0
let total = 0

function record (name, ok, detail) {
  total += 1
  if (!ok) failed += 1
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  #${total} ${name}  — ${detail}`)
}

function slotsPayload (slots = {}) {
  const names = ['background', 'boot', 'screensaver']
  const out = {}
  for (const name of names) {
    out[name] = { enabled: false, mediaId: null, revision: 0, ...(slots[name] ?? {}) }
  }
  return {
    ok: true,
    config: {
      revision: 1,
      slots: out,
      options: {
        background: { surface: 0, muted: true, pauseWhenHidden: true },
        boot: { muted: true },
        screensaver: { idleMs: 300000, volume: 0, muted: true },
      },
    },
    ignored: [],
  }
}

function entry (id) {
  return {
    id,
    name: id + '.mp4',
    kind: 'video',
    ext: '.mp4',
    bytes: 1024,
    contentHash: 'hash-' + id,
    source: 'library',
    license: 'unknown',
    addedAt: 0,
    mediaUrl: '/appearance-media/media/' + id,
  }
}

function catalogPayload (entries) {
  return { ok: true, revision: 1, entries }
}

/**
 * Run the arbitration point in a sandbox with a fake page.
 *
 * @param controllerText - the controller source to run.
 * @param slots - the slot configuration the fake route publishes.
 * @param catalog - the catalog the fake route publishes.
 * @returns the sandbox and the mounts it saw.
 */
function runSandbox (controllerText, slots, catalog) {
  const mounts = []
  const body = {
    children: [],
    appendChild (element) {
      body.children.push(element)
      mounts.push(element)
      return element
    },
    removeChild (element) {
      body.children = body.children.filter((child) => child !== element)
      return element
    },
  }
  const document = {
    body,
    createElement (tag) {
      return {
        tagName: String(tag).toUpperCase(),
        src: '',
        parentNode: null,
        style: {},
        setAttribute () {},
        removeAttribute () {},
        addEventListener () {},
        removeEventListener () {},
        remove () {
          if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
            this.parentNode.removeChild(this)
          }
        },
      }
    },
  }
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    // ★ NO REAL INTERVAL: the arbitration point may arm a poll, and a live
    // interval would keep this process running forever.
    setInterval: () => 0,
    clearInterval,
    Promise,
    document,
    fetch (url) {
      if (String(url).indexOf('/appearance-media/slots') >= 0) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(slotsPayload(slots)) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(catalogPayload(catalog)) })
    },
  }
  sandbox.globalThis = sandbox
  // ★ THE GLOBAL HOST: a slot that has no surface of its own falls back to
  // it. Without it the arbitration point refuses the material — which is the
  // "never lands on the body" rule doing its job, not a bug in this file.
  sandbox.__DSH_APPEARANCE_HOST__ = {
    createElement: (tag) => document.createElement(tag),
    mount (element) {
      if (element.parentNode === null) element.parentNode = body
      body.appendChild(element)
    },
    unmount (element) {
      if (typeof element.remove === 'function') element.remove()
    },
  }
  // ★ A FAKE RENDERER FACTORY: the controller asks the renderers for a
  // renderer and never touches the media element itself.
  sandbox.__DSH_APPEARANCE_RENDERERS__ = {
    create (mediaEntry) {
      const element = document.createElement('video')
      element.src = mediaEntry.mediaUrl
      return {
        el: () => element,
        start: () => Promise.resolve(),
        dispose: () => {},
        onShown: () => {},
        onEnded: () => {},
        onStall: () => {},
        onError: () => {},
        duration: () => 10,
        currentTime: () => 0,
        hasAudio: () => false,
        setVolume: () => {},
        mute: () => {},
        isMuted: () => true,
        isEnded: () => false,
        isPaused: () => true,
        getVolume: () => 0,
        mediaError: () => null,
      }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(controllerText, sandbox, { filename: 'controller.js' })
  return { sandbox, controller: sandbox.__DSH_APPEARANCE_CONTROLLER__, mounts }
}

function tick () {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * A surface that can hand out its material — like the boot surface does.
 *
 * @param catalog - the catalog to resolve from.
 * @returns a host interface for `registerHost`.
 */
function fakeSurface (catalog) {
  const created = []
  return {
    created,
    createElement (tag) {
      const element = {
        tagName: String(tag).toUpperCase(),
        src: '',
        parentNode: null,
        style: {},
        setAttribute () {},
        removeAttribute () {},
        addEventListener () {},
        removeEventListener () {},
        remove () {},
      }
      created.push(element)
      return element
    },
    mount (element) {
      if (element.parentNode === null) element.parentNode = { removeChild () {} }
    },
    unmount (element) {
      if (typeof element.remove === 'function') element.remove()
    },
    ensure () {
      return { createElement: this.createElement, mount: this.mount, unmount: this.unmount }
    },
    resolve (mediaId) {
      const found = catalog.find((row) => row.id === mediaId)
      return Promise.resolve(found === undefined ? null : found)
    },
  }
}

/**
 * The scenario: a slot that never played must not be dragged onto the stage.
 *
 * @param controllerText - the controller source to run.
 * @returns what the arbitration point did.
 */
async function scenario (controllerText) {
  const catalog = [entry('up-bg'), entry('up-boot'), entry('up-sv')]
  const run = runSandbox(controllerText, {
    background: { enabled: true, mediaId: 'up-bg', revision: 1 },
    boot: { enabled: true, mediaId: 'up-boot', revision: 1 },
    screensaver: { enabled: true, mediaId: 'up-sv', revision: 1 },
  }, catalog)
  // ★ THE BOOT SURFACE IS REGISTERED: it can resolve its own material, so
  // the arbitration point COULD pull it onto the stage. That is exactly the
  // footgun this file pins down.
  const bootSurface = fakeSurface(catalog)
  run.controller.registerHost('boot', bootSurface)

  run.controller.apply('background', entry('up-bg'))
  await tick()
  run.controller.apply('screensaver', entry('up-sv'))
  await tick()
  const before = run.controller.state()
  run.controller.release('screensaver')
  await tick()
  await tick()
  const after = run.controller.state()
  const mounted = run.mounts.map((element) => String(element.src))
  return {
    before: before.slot,
    after: after.slot,
    bootMounted: mounted.some((src) => src.indexOf('up-boot') >= 0),
    backgroundMounted: mounted.some((src) => src.indexOf('up-bg') >= 0),
  }
}

// ---------------------------------------------------------------- the checks

// ★ #1 — the hand-over: the slot that was pushed off comes back.
{
  const good = await scenario(CONTROLLER_TEXT)
  record(
    '#1 a pushed-off slot comes back, and a slot that never played does not',
    good.after === 'background' && good.backgroundMounted === true && good.bootMounted === false,
    'good=' + JSON.stringify(good),
  )
}

// ★ #2 — THE NEGATIVE CONTROL: put the old clause back and the check fails.
{
  const brokenText = CONTROLLER_TEXT.replace(
    '      if (displaced[name] !== true) continue',
    '      if (displaced[name] !== true && slotEntries[name] !== undefined) continue',
  )
  const changed = brokenText !== CONTROLLER_TEXT
  const broken = changed ? await scenario(brokenText) : { after: null, bootMounted: null }
  record(
    '#2 the negative control: the old clause drags the boot slot onto the stage',
    // ★ THE SIGNAL IS THE STAGE ITSELF: with the old clause the boot slot
    // takes the stage (`after === 'boot'`) instead of the pushed-off
    // background coming back.
    changed === true && broken.after === 'boot' && broken.after !== 'background',
    'changed=' + changed + ' broken=' + JSON.stringify(broken),
  )
}

// ★ #3 — the rule in the source: a candidate is a slot that was PUSHED OFF.
{
  const rule = /if \(displaced\[name\] !== true\) continue/.test(CONTROLLER_TEXT)
  const stale = /displaced\[name\] !== true && slotEntries\[name\] !== undefined/.test(CONTROLLER_TEXT)
  record(
    '#3 the source says: only a pushed-off slot is a candidate',
    rule === true && stale === false,
    'rule=' + rule + ' staleClause=' + stale,
  )
}

console.log(`\n${total} check(s), ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
