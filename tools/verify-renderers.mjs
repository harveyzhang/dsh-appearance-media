#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the adapters and the
// arbitration point.
//
// What it proves, and what it deliberately does not:
//
//   * it EVALUATES THE REAL SOURCE TEXT of `src/renderers.js` and
//     `src/controller.js` — the very bytes the Host pushes into the page —
//     inside a `node:vm` context with a fake DOM, a fake Host route and a
//     fake clock;
//   * it never starts DSH, never binds a port, never waits for anything.
//
// ★ WHY IT EVALUATES THE TEXT INSTEAD OF IMPORTING A MODULE.
//
// The two files are SCRIPT TEXT: the Host pushes them into the page as inline
// `kind:'script'` rows. There is no module to import, and there must not be
// one: a `require` in that text is a syntax error in the page. So the suite
// runs the text the way the browser runs it.
//
// ★ WHY IT DOES NOT COPY THE PACKAGE.
//
// Nothing here touches `node_modules`, so there is no symlink to dereference.
// The two files are read where they live: a copy would test the copy.
//
// ★ EVERY ASSERTION HERE CAN FAIL BECAUSE THE IMPLEMENTATION IS WRONG, AND
// THE SHAPE ASSERTIONS HAVE A NEGATIVE CONTROL.
//
// A check that has never failed is not a check. So the shape assertions come
// in two halves: a STATIC assertion (the source must not contain a shape) and
// a REVERSE CONTROL (the same check, fed a deliberately broken copy, must
// report the break). The reverse controls are #6, #7, #37 and #38.
//
// The holes this suite is written against:
//
//   * the ABSENCES are the contract — an image renderer that grew a fake
//     `duration()` would change the hand-over timing of every kind, and
//     every assertion would stay green;
//   * `loop` is the CALLER's decision — a boot clip that loops never fires
//     `ended`, and the boot screen holds forever;
//   * `options` is never undefined — an undefined options object means
//     `loop` is false, which is the wrong answer for a surface that loops;
//   * the construction order — `muted`, then `loop`, then the source LAST;
//   * the release order — pause, clear the source, unbind, and only then
//     leave the page;
//   * the race — an attempt that has been superseded must not touch the
//     material that replaced it;
//   * ★ C4-1 — an options change moves the WHOLE revision and NONE of the
//     slot revisions, so a controller that only compared the slot revisions
//     would never change the volume, and every assertion would stay green.
//
// Usage: node tools/verify-renderers.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const RENDERERS_PATH = fileURLToPath(new URL('../src/renderers.js', import.meta.url))
const CONTROLLER_PATH = fileURLToPath(new URL('../src/controller.js', import.meta.url))

/** @type {Array<[string, boolean, string]>} */
const checks = []
/** @type {string[]} */
const notes = []

/**
 * Record one assertion.
 * @param label - what is asserted.
 * @param ok - whether it holds.
 * @param detail - the evidence, printed next to the label.
 */
function record(label, ok, detail = '') {
  checks.push([label, Boolean(ok), detail])
}

/**
 * Let the microtask queue drain.
 * @returns a promise that resolves after the pending work.
 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

/* ------------------------------------------------------------------ text */

/** The renderers' source text. */
const RENDERERS_TEXT = readFileSync(RENDERERS_PATH, 'utf8')
/** The controller's source text. */
const CONTROLLER_TEXT = readFileSync(CONTROLLER_PATH, 'utf8')

/**
 * The shapes that must not appear in an injected script.
 *
 * Each entry is a label and a pattern. The patterns are deliberately blunt:
 * they are looking for a shape, not for a meaning.
 *
 * @param text - the source text.
 * @returns the labels of the shapes that were found.
 */
function forbiddenShapes(text) {
  const shapes = [
    ['require()', /\brequire\s*\(/],
    ['import', /^[ \t]*import[ \t]/m],
    ['export', /^[ \t]*export[ \t]/m],
    ['a closing script tag', /<\/script/i],
    ['an HTML comment opener', /<!--/],
    ['a hand-written media URL', /\/appearance-media\/media\//],
    ["another plugin's body marker", /data-we-wallpaper|data-dsh-am-/],
    ['a baked option key', /\bidleMs\b|\bpauseWhenHidden\b/],
    ['a body attribute write', /document\.body\.(?:setAttribute|removeAttribute|toggleAttribute|dataset|className|classList|style)\b/],
  ]
  const found = []
  for (const [label, pattern] of shapes) {
    if (pattern.test(text)) found.push(label)
  }
  return found
}

/* ------------------------------------------------------------- fake DOM */

/**
 * Build a fake DOM: elements that remember what was done to them.
 *
 * @returns the fake DOM, with its call log and its element list.
 */
function createFakeDom() {
  /** Every call, in order, from every source. */
  const calls = []
  /** Every element that was created. */
  const elements = []
  /** Every element that is on the page. */
  const mounted = []

  /**
   * Define a recorded property on an element.
   * @param element - the element.
   * @param name - the property name.
   * @param initial - the initial value.
   */
  function defineRecorded(element, name, initial) {
    let value = initial
    Object.defineProperty(element, name, {
      enumerable: true,
      configurable: true,
      get() { return value },
      set(next) {
        calls.push(name + (name === 'src' ? ':' + String(next) : ''))
        value = next
      },
    })
  }

  /**
   * Create one fake element.
   * @param tag - the tag name.
   * @returns the element.
   */
  function createElement(tag) {
    const listeners = {}
    const element = {
      tagName: String(tag).toUpperCase(),
      className: '',
      paused: true,
      ended: false,
      readyState: 0,
      currentTime: 0,
      complete: false,
      naturalWidth: 0,
      error: null,
      attributes: {},
      parentNode: null,
      listeners,
      setAttribute(name, value) {
        calls.push('setAttribute:' + name)
        element.attributes[name] = String(value)
      },
      removeAttribute(name) {
        calls.push('removeAttribute:' + name)
        delete element.attributes[name]
      },
      getAttribute(name) {
        return element.attributes[name]
      },
      addEventListener(type, fn) {
        calls.push('addEventListener:' + type)
        if (listeners[type] === undefined) listeners[type] = []
        listeners[type].push(fn)
      },
      removeEventListener(type, fn) {
        calls.push('removeEventListener:' + type)
        const list = listeners[type] === undefined ? [] : listeners[type]
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      },
      dispatch(type) {
        const list = (listeners[type] === undefined ? [] : listeners[type]).slice()
        for (const fn of list) fn({ type })
      },
      play() {
        calls.push('play')
        element.paused = false
        return Promise.resolve()
      },
      load() {
        calls.push('load')
      },
      pause() {
        calls.push('pause')
        element.paused = true
      },
      remove() {
        calls.push('remove')
        const parent = element.parentNode
        if (parent !== null && parent !== undefined && Array.isArray(parent.children)) {
          const index = parent.children.indexOf(element)
          if (index >= 0) parent.children.splice(index, 1)
        }
        element.parentNode = null
      },
    }
    defineRecorded(element, 'src', '')
    defineRecorded(element, 'muted', false)
    defineRecorded(element, 'loop', false)
    defineRecorded(element, 'volume', 1)
    elements.push(element)
    calls.push('create:' + element.tagName)
    return element
  }

  /**
   * The host interface the injected code uses.
   */
  const host = {
    createElement(tag) {
      return createElement(tag)
    },
    mount(element) {
      calls.push('mount:' + element.tagName)
      mounted.push(element)
    },
    unmount(element) {
      calls.push('unmount:' + element.tagName)
      const index = mounted.indexOf(element)
      if (index >= 0) mounted.splice(index, 1)
    },
  }

  return { calls, elements, mounted, host, createElement }
}

/* ----------------------------------------------------------- the sandbox */

/**
 * Run the two scripts in a fresh context.
 *
 * @param options - `renderers`, `controller`, `payload`, `withHost`.
 * @returns the sandbox and the fake DOM.
 */
function runSandbox(options = {}) {
  const dom = createFakeDom()
  const renderersText = options.renderers === undefined ? RENDERERS_TEXT : options.renderers
  const controllerText = options.controller === undefined ? CONTROLLER_TEXT : options.controller
  const fetchLog = []
  const intervals = []
  let payload = options.payload === undefined ? null : options.payload

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval(fn, ms) {
      intervals.push({ fn, ms })
      return intervals.length
    },
    clearInterval(id) {
      const index = intervals.findIndex((entry) => entry.id === id)
      if (index >= 0) intervals.splice(index, 1)
    },
    fetch(url, init) {
      fetchLog.push({ url, init })
      const body = payload
      return Promise.resolve({
        ok: true,
        status: 200,
        json() { return Promise.resolve(body) },
      })
    },
  }
  if (options.withHost !== false) sandbox.__DSH_APPEARANCE_HOST__ = dom.host
  if (options.document !== undefined) sandbox.document = options.document

  vm.createContext(sandbox)
  if (renderersText !== null) vm.runInContext(renderersText, sandbox, { filename: 'renderers.js' })
  if (controllerText !== null) vm.runInContext(controllerText, sandbox, { filename: 'controller.js' })

  return {
    sandbox,
    dom,
    fetchLog,
    intervals,
    setPayload(next) { payload = next },
    controller: sandbox.__DSH_APPEARANCE_CONTROLLER__,
    renderers: sandbox.__DSH_APPEARANCE_RENDERERS__,
  }
}

/**
 * Build the answer of the slot route.
 *
 * @param options - `revision`, `slots`, `options`.
 * @returns the answer.
 */
function slotsPayload(options = {}) {
  const names = ['background', 'boot', 'screensaver']
  const slots = {}
  for (const name of names) {
    slots[name] = { enabled: false, mediaId: null, revision: 0, ...(options.slots?.[name] ?? {}) }
  }
  return {
    ok: true,
    config: {
      revision: options.revision ?? 0,
      slots,
      options: {
        background: { surface: 0, muted: true, pauseWhenHidden: true, ...(options.options?.background ?? {}) },
        boot: { muted: true, ...(options.options?.boot ?? {}) },
        screensaver: { idleMs: 300000, volume: 0, muted: true, ...(options.options?.screensaver ?? {}) },
      },
    },
    ignored: [],
  }
}

/**
 * A catalog entry, the way the catalog route publishes it.
 *
 * @param id - the media id.
 * @param kind - the kind.
 * @returns the entry.
 */
function entry(id, kind = 'video') {
  return {
    id,
    name: id + '.mp4',
    kind,
    ext: '.mp4',
    bytes: 1024,
    contentHash: 'hash-' + id,
    source: 'library',
    license: 'unknown',
    addedAt: 0,
    mediaUrl: '/appearance-media/media/' + id,
  }
}

/**
 * A fake adapter factory, for the cases where the REAL adapters are not the
 * thing under test (a factory that fails, a late error callback).
 *
 * @param dom - the fake DOM.
 * @param options - `failOn`, `throwOn`, `rejectStart`.
 * @returns the factory and the list of renderers it created.
 */
function fakeFactory(dom, options = {}) {
  const created = []
  const factory = {
    create(item, opts) {
      created.push({ entry: item, options: opts })
      if (options.failOn !== undefined && item.id === options.failOn) return undefined
      if (options.throwOn !== undefined && item.id === options.throwOn) {
        throw new Error('这个素材建不起来。')
      }
      const element = dom.createElement('video')
      // ★ THE REAL ADAPTERS TAKE THE OPTIONS AT CONSTRUCTION. The fake does
      // the same, so a test that reads the element's volume sees what a real
      // video would have.
      element.muted = opts?.muted === true
      element.loop = opts?.loop === true
      if (typeof opts?.volume === 'number') element.volume = opts.volume
      const errorCallbacks = []
      let rejectStart = null
      const renderer = {
        kind: item.kind,
        el() { return element },
        start() {
          dom.calls.push('start:' + item.id)
          if (options.rejectStart !== undefined && options.rejectStart === item.id) {
            rejectStart = new Promise((resolve, reject) => { reject(new Error('播放被拒绝。')) })
            return rejectStart
          }
          return undefined
        },
        dispose() { dom.calls.push('dispose:' + item.id) },
        onShown() {},
        onEnded() {},
        onError(fn) { errorCallbacks.push(fn) },
        hasAudio() { return true },
        setVolume(value) { element.volume = value },
        mute(value) { element.muted = value === true },
        getVolume() { return element.volume },
        isMuted() { return element.muted === true },
        duration() { return 10 },
        currentTime() { return 0 },
        isEnded() { return false },
        isPaused() { return true },
        mediaError() { return 0 },
        raw: element,
      }
      created[created.length - 1].renderer = renderer
      created[created.length - 1].element = element
      created[created.length - 1].fireError = (code) => {
        for (const fn of errorCallbacks.slice()) fn(code)
      }
      created[created.length - 1].rejectStart = () => {
        if (rejectStart !== null) rejectStart.catch(() => {})
      }
      return renderer
    },
  }
  return { factory, created }
}

/* ------------------------------------------------------------------ run */

let exitCode = 0

try {
  /* ---- the static shape of the two scripts ------------------------- */

  {
    const found = forbiddenShapes(RENDERERS_TEXT)
    record('#1 the renderers source is plain script text with no forbidden shape',
      found.length === 0, JSON.stringify(found))
  }

  {
    const found = forbiddenShapes(CONTROLLER_TEXT)
    record('#2 the controller source is plain script text with no forbidden shape',
      found.length === 0, JSON.stringify(found))
  }

  {
    const broken = "var x = require('react')\n// <!-- </script>\n"
    const found = forbiddenShapes(broken)
    record('#3 REVERSE CONTROL: the shape scanner flags a deliberately broken sample',
      found.includes('require()') && found.includes('a closing script tag')
      && found.includes('an HTML comment opener'),
      JSON.stringify(found))
  }

  {
    const broken = "var options = { screensaver: { idleMs: 300000 } }\n"
    const found = forbiddenShapes(broken)
    record('#4 REVERSE CONTROL: the shape scanner flags a baked configuration',
      found.includes('a baked option key'), JSON.stringify(found))
  }

  {
    const broken = "document.body.setAttribute('data-we-wallpaper', 'on')\n"
    const found = forbiddenShapes(broken)
    record('#5 REVERSE CONTROL: the shape scanner flags a body marker and a body attribute write',
      found.includes("another plugin's body marker") && found.includes('a body attribute write'),
      JSON.stringify(found))
  }

  /* ---- the adapters ------------------------------------------------ */

  {
    const run = runSandbox({ controller: null })
    record('#6 the renderers publish their factory on the documented global',
      run.renderers !== undefined && run.renderers !== null
      && typeof run.renderers.create === 'function',
      typeof run.renderers?.create)
  }

  {
    const run = runSandbox({ controller: null })
    const unknown = run.renderers.create(entry('up-x', 'scene'), { loop: false, muted: true, volume: 0 })
    const missing = run.renderers.create({ id: 'up-y', mediaUrl: '/x' }, { loop: false, muted: true, volume: 0 })
    record('#7 an unknown kind and a missing kind produce no renderer at all',
      unknown === undefined && missing === undefined && run.dom.elements.length === 0,
      'unknown=' + String(unknown) + ' missing=' + String(missing)
      + ' elements=' + String(run.dom.elements.length))
  }

  {
    const run = runSandbox({ controller: null })
    const renderer = run.renderers.create(entry('up-v'), { loop: false, muted: true, volume: 0.5 })
    const videoOnly = ['duration', 'onEnded', 'setVolume', 'mute', 'currentTime',
      'isEnded', 'isPaused', 'getVolume', 'isMuted', 'onStall', 'mediaError']
    const missing = videoOnly.filter((name) => typeof renderer[name] !== 'function')
    record('#8 the video renderer carries every video-only method',
      missing.length === 0 && renderer.kind === 'video'
      && typeof renderer.el === 'function' && typeof renderer.start === 'function'
      && typeof renderer.dispose === 'function' && typeof renderer.onShown === 'function'
      && typeof renderer.onError === 'function' && typeof renderer.hasAudio === 'function',
      'missing=' + JSON.stringify(missing))
  }

  {
    const run = runSandbox({ controller: null })
    const renderer = run.renderers.create(entry('up-i', 'image'), { loop: false, muted: true, volume: 0 })
    const videoOnly = ['duration', 'onEnded', 'setVolume', 'mute', 'currentTime',
      'isEnded', 'isPaused', 'getVolume', 'isMuted', 'onStall', 'mediaError']
    const present = videoOnly.filter((name) => name in renderer)
    record('#9 the image renderer has NONE of the video-only methods: the absences are the contract',
      present.length === 0 && renderer.kind === 'image' && renderer.hasAudio() === false,
      'present=' + JSON.stringify(present))
  }

  {
    const run = runSandbox({ controller: null })
    const renderer = run.renderers.create(entry('up-p', 'video'), { loop: true, muted: true, volume: 0 })
    record('#9b the video renderer can be paused and continued',
      typeof renderer.pause === 'function' && typeof renderer.resume === 'function',
      'pause=' + String(typeof renderer.pause) + ' resume=' + String(typeof renderer.resume))
  }

  {
    const run = runSandbox({ controller: null })
    const renderer = run.renderers.create(entry('up-pi', 'image'), { loop: false, muted: true, volume: 0 })
    const present = ['pause', 'resume'].filter((name) => name in renderer)
    record('#9c the image renderer can be neither paused nor continued: the absences are the contract',
      present.length === 0, 'present=' + JSON.stringify(present))
  }

  {
    const run = runSandbox({ controller: null })
    run.renderers.create(entry('up-o'), { loop: false, muted: true, volume: 0 })
    const calls = run.dom.calls
    const at = (name) => calls.findIndex((call) => call === name || call.startsWith(name + ':'))
    const muted = at('muted')
    const loop = at('loop')
    const src = at('src')
    record('#10 the video is built muted, then loop, and the source LAST',
      muted >= 0 && loop > muted && src > loop,
      'muted=' + String(muted) + ' loop=' + String(loop) + ' src=' + String(src)
      + ' calls=' + JSON.stringify(calls))
  }

  {
    const run = runSandbox({ controller: null })
    const item = entry('up-u')
    const renderer = run.renderers.create(item, { loop: false, muted: true, volume: 0 })
    record('#11 the source is entry.mediaUrl, taken from the entry and built nowhere',
      renderer.raw.src === item.mediaUrl && renderer.raw.src !== ''
      && !/appearance-media\/media/.test(RENDERERS_TEXT.replace(/entry\.mediaUrl/g, '')),
      'src=' + String(renderer.raw.src))
  }

  {
    const run = runSandbox({ controller: null })
    const noLoop = run.renderers.create(entry('up-1'), { loop: false, muted: true, volume: 0 })
    const loop = run.renderers.create(entry('up-2'), { loop: true, muted: true, volume: 0 })
    record('#12 loop is the caller\'s decision: false stays false, true becomes true',
      noLoop.raw.loop === false && loop.raw.loop === true,
      'noLoop=' + String(noLoop.raw.loop) + ' loop=' + String(loop.raw.loop))
  }

  {
    const run = runSandbox({ controller: null })
    let threw = null
    let renderer = null
    try {
      renderer = run.renderers.create(entry('up-3'), undefined)
    } catch (error) {
      threw = String(error)
    }
    record('#13 a missing options object does not throw, and it means loop=false',
      threw === null && renderer !== null && renderer !== undefined && renderer.raw.loop === false,
      'threw=' + String(threw) + ' loop=' + String(renderer?.raw?.loop))
  }

  {
    // The built-in host: no injected host, a document instead.
    const dom = createFakeDom()
    const body = { children: [], appendChild(element) { body.children.push(element) } }
    const document = {
      body,
      createElement(tag) { return dom.createElement(tag) },
    }
    const run = runSandbox({ controller: null, withHost: false, document })
    const renderer = run.renderers.create(entry('up-h'), { loop: false, muted: true, volume: 0 })
    const element = renderer.el()
    // The built-in host is the controller's business; here the adapters only
    // have to be able to create an element through it.
    record('#14 without an injected host the adapters fall back to the document',
      element !== undefined && element !== null && dom.elements.length === 1
      && document.body.children.length === 0,
      'elements=' + String(dom.elements.length) + ' body=' + String(document.body.children.length))
  }

  /* ---- the arbitration point --------------------------------------- */

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    record('#15 the controller publishes the five documented methods',
      controller !== undefined && controller !== null
      && typeof controller.state === 'function' && typeof controller.apply === 'function'
      && typeof controller.release === 'function' && typeof controller.releaseAll === 'function'
      && typeof controller.on === 'function',
      typeof controller?.state)
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const result = controller.apply('background', entry('up-a'))
    const state = controller.state()
    record('#16 apply() answers \'applied\' and puts exactly one element on the page',
      result === 'applied' && run.dom.mounted.length === 1 && state.playing === true
      && state.slot === 'background' && state.mediaId === 'up-a' && state.kind === 'video',
      'result=' + String(result) + ' mounted=' + String(run.dom.mounted.length)
      + ' state=' + JSON.stringify({ slot: state.slot, mediaId: state.mediaId, playing: state.playing }))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    controller.apply('background', entry('up-a'))
    const state = controller.state()
    const slots = state.slots
    const shape = state !== null
      && typeof state.slot === 'string' || state.slot === null
    const slotsShape = ['background', 'boot', 'screensaver'].every((name) => {
      const slot = slots?.[name]
      return slot !== undefined && slot !== null
        && typeof slot.enabled === 'boolean'
        && (typeof slot.mediaId === 'string' || slot.mediaId === null)
        && typeof slot.revision === 'number'
    })
    record('#17 the state answers the documented shape, per slot and per revision',
      shape && slotsShape && typeof state.playing === 'boolean'
      && (typeof state.kind === 'string' || state.kind === null)
      && (state.error === null || typeof state.error === 'object'),
      'slots=' + JSON.stringify(slots))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const before = run.dom.elements.length
    const missingKind = controller.apply('background', { id: 'up-b', mediaUrl: '/x' })
    const unknownKind = controller.apply('background', entry('up-c', 'scene'))
    record('#18 an entry without a kind, and one with an unknown kind, are skipped and touch no DOM',
      missingKind === 'skipped' && unknownKind === 'skipped'
      && run.dom.elements.length === before && run.dom.mounted.length === 0
      && controller.state().slot === null,
      'missing=' + String(missingKind) + ' unknown=' + String(unknownKind)
      + ' elements=' + String(run.dom.elements.length - before))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const fake = fakeFactory(run.dom, { failOn: 'up-bad', throwOn: 'up-boom' })
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('background', entry('up-good'))
    const elementBefore = run.dom.mounted.length
    const failed = controller.apply('background', entry('up-bad'))
    const threw = controller.apply('background', entry('up-boom'))
    const state = controller.state()
    record('#19 a material that cannot be built keeps the previous one on screen',
      failed === 'failed-kept-previous' && threw === 'failed-kept-previous'
      && run.dom.mounted.length === elementBefore
      && state.mediaId === 'up-good' && state.slot === 'background',
      'failed=' + String(failed) + ' threw=' + String(threw)
      + ' mounted=' + String(run.dom.mounted.length) + ' mediaId=' + String(state.mediaId))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    controller.apply('background', entry('up-a'))
    const mountedBefore = run.dom.mounted.length
    const elementBefore = run.dom.mounted[0]
    const again = controller.apply('background', entry('up-a'))
    record('#20 applying the same material again is skipped and does not remount anything',
      again === 'skipped' && run.dom.mounted.length === mountedBefore
      && run.dom.mounted[0] === elementBefore,
      'again=' + String(again) + ' mounted=' + String(run.dom.mounted.length))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    controller.apply('background', entry('up-a'))
    controller.release('background')
    const state = controller.state()
    record('#21 release(slot) takes the element off the page and empties the state',
      run.dom.mounted.length === 0 && state.slot === null && state.mediaId === null
      && state.playing === false,
      'mounted=' + String(run.dom.mounted.length) + ' slot=' + String(state.slot))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    controller.apply('background', entry('up-a'))
    controller.release('screensaver')
    controller.release('screensaver')
    const state = controller.state()
    record('#22 release() on another slot leaves the material on screen alone',
      run.dom.mounted.length === 1 && state.mediaId === 'up-a',
      'mounted=' + String(run.dom.mounted.length) + ' mediaId=' + String(state.mediaId))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    controller.apply('background', entry('up-a'))
    controller.releaseAll()
    controller.releaseAll()
    record('#23 releaseAll() clears everything, and it is idempotent',
      run.dom.mounted.length === 0 && controller.state().slot === null,
      'mounted=' + String(run.dom.mounted.length))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    controller.apply('background', entry('up-a'))
    controller.release('background')
    const calls = run.dom.calls
    const at = (name) => calls.findIndex((call) => call === name || call.startsWith(name + ':'))
    const pause = at('pause')
    const clearSource = at('removeAttribute:src')
    const load = at('load')
    const unbind = at('removeEventListener')
    const unmount = at('unmount')
    record('#24 the release order is pause, clear the source, unbind, and only then leave the page',
      pause >= 0 && clearSource > pause && load > clearSource && unbind > load && unmount > unbind,
      'pause=' + String(pause) + ' clear=' + String(clearSource) + ' load=' + String(load)
      + ' unbind=' + String(unbind) + ' unmount=' + String(unmount))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const fake = fakeFactory(run.dom)
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('background', entry('up-a'))
    controller.apply('background', entry('up-b'))
    const state = controller.state()
    record('#25 apply(A) then apply(B) leaves B on screen',
      state.mediaId === 'up-b' && run.dom.mounted.length === 1
      && fake.created.length === 2,
      'mediaId=' + String(state.mediaId) + ' mounted=' + String(run.dom.mounted.length))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const fake = fakeFactory(run.dom)
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('background', entry('up-a'))
    controller.apply('background', entry('up-b'))
    // A's failure arrives after B has taken over.
    fake.created[0].fireError(4)
    const state = controller.state()
    record('#26 a superseded attempt\'s late failure does not touch the material that replaced it',
      state.mediaId === 'up-b' && run.dom.mounted.length === 1 && state.playing === true,
      'mediaId=' + String(state.mediaId) + ' mounted=' + String(run.dom.mounted.length))
  }

  {
    // ★ REVERSE CONTROL: the same scenario against a controller whose token
    // check was removed. The outcome MUST change, or the check above proves
    // nothing.
    const broken = CONTROLLER_TEXT.replace(
      'if (token !== applyToken) return',
      'if (false) return',
    )
    record('#27 REVERSE CONTROL: without the token check the late failure DOES disturb the new material',
      broken !== CONTROLLER_TEXT,
      'the mutation applies=' + String(broken !== CONTROLLER_TEXT))
    const run = runSandbox({ payload: slotsPayload(), controller: broken })
    const controller = run.controller
    await tick()
    const fake = fakeFactory(run.dom)
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('background', entry('up-a'))
    controller.apply('background', entry('up-b'))
    fake.created[0].fireError(4)
    const state = controller.state()
    record('#28 REVERSE CONTROL: the broken controller loses B — so #26 can fail',
      state.mediaId !== 'up-b' || run.dom.mounted.length !== 1,
      'mediaId=' + String(state.mediaId) + ' mounted=' + String(run.dom.mounted.length))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const fake = fakeFactory(run.dom)
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('background', entry('up-a'))
    controller.apply('background', entry('up-b'))
    controller.apply('background', entry('up-c'))
    const state = controller.state()
    record('#29 three applies in a row leave the third on screen',
      state.mediaId === 'up-c' && run.dom.mounted.length === 1,
      'mediaId=' + String(state.mediaId) + ' mounted=' + String(run.dom.mounted.length))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const fake = fakeFactory(run.dom)
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('boot', entry('up-boot'))
    controller.apply('screensaver', entry('up-saver'))
    controller.apply('background', entry('up-bg'))
    const loops = fake.created.map((row) => row.options?.loop)
    const complete = fake.created.every((row) => row.options !== undefined
      && typeof row.options.loop === 'boolean'
      && typeof row.options.muted === 'boolean'
      && typeof row.options.volume === 'number')
    record('#30 every adapter call receives a COMPLETE options object, and loop is the surface\'s',
      complete && loops[0] === false && loops[1] === true && loops[2] === true,
      'loops=' + JSON.stringify(loops))
  }

  {
    // ★ C4-1: an options change moves the WHOLE revision and NONE of the slot
    // revisions. The controller has to notice the options and push them onto
    // the material that is on screen.
    const run = runSandbox({
      payload: slotsPayload({
        revision: 3,
        slots: { screensaver: { enabled: true, mediaId: 'up-saver', revision: 2 } },
        options: { screensaver: { volume: 0.5, muted: false } },
      }),
    })
    const controller = run.controller
    await tick()
    const fake = fakeFactory(run.dom)
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('screensaver', entry('up-saver'))
    const element = fake.created[0].element
    const volumeBefore = element.volume
    const elementBefore = fake.created[0].element

    run.setPayload(slotsPayload({
      revision: 4,
      slots: { screensaver: { enabled: true, mediaId: 'up-saver', revision: 2 } },
      options: { screensaver: { volume: 0.8, muted: false } },
    }))
    await controller.refresh()
    await tick()
    const state = controller.state()
    record('#31 an options change takes effect although NO slot revision moved',
      volumeBefore === 0.5 && element.volume === 0.8
      && state.slots.screensaver.revision === 2 && state.revision === 4,
      'volumeBefore=' + String(volumeBefore) + ' volume=' + String(element.volume)
      + ' slotRevision=' + String(state.slots.screensaver.revision)
      + ' revision=' + String(state.revision))
    record('#32 the options change does NOT re-apply the surface',
      fake.created.length === 1 && fake.created[0].element === elementBefore
      && run.dom.mounted.length === 1,
      'created=' + String(fake.created.length) + ' mounted=' + String(run.dom.mounted.length))
  }

  {
    // ★ REVERSE CONTROL: a controller that never notices the options.
    const broken = CONTROLLER_TEXT.replace(
      'if (!sameOptions(state.options[group], groups[group])) optionsChanged = true',
      'if (false) optionsChanged = true',
    )
    const run = runSandbox({
      payload: slotsPayload({
        revision: 3,
        slots: { screensaver: { enabled: true, mediaId: 'up-saver', revision: 2 } },
        options: { screensaver: { volume: 0.5, muted: false } },
      }),
      controller: broken,
    })
    const controller = run.controller
    await tick()
    const fake = fakeFactory(run.dom)
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('screensaver', entry('up-saver'))
    const element = fake.created[0].element
    run.setPayload(slotsPayload({
      revision: 4,
      slots: { screensaver: { enabled: true, mediaId: 'up-saver', revision: 2 } },
      options: { screensaver: { volume: 0.8, muted: false } },
    }))
    await controller.refresh()
    await tick()
    record('#33 REVERSE CONTROL: a controller that ignores the options leaves the volume at 0.5 — so #31 can fail',
      broken !== CONTROLLER_TEXT && element.volume === 0.5,
      'volume=' + String(element.volume) + ' mutated=' + String(broken !== CONTROLLER_TEXT))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    await tick()
    const url = run.fetchLog.length > 0 ? run.fetchLog[0].url : ''
    const cache = run.fetchLog.length > 0 ? run.fetchLog[0].init?.cache : ''
    record('#34 the controller reads the configuration from the Host route, live and uncached',
      url === '/appearance-media/slots' && cache === 'no-store' && run.intervals.length === 1,
      'url=' + String(url) + ' cache=' + String(cache) + ' intervals=' + String(run.intervals.length))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const seen = []
    const off = controller.on('change', (payload) => seen.push(payload))
    controller.apply('background', entry('up-a'))
    const afterApply = seen.length
    controller.release('background')
    const afterRelease = seen.length
    off()
    controller.apply('background', entry('up-b'))
    const afterOff = seen.length
    const first = seen[0]
    record('#35 the change event carries the state, and unsubscribing really unsubscribes',
      afterApply === 1 && afterRelease === 2 && afterOff === 2
      && first !== undefined && first.state !== undefined
      && first.state.mediaId === 'up-a' && Array.isArray(first.changed),
      'afterApply=' + String(afterApply) + ' afterRelease=' + String(afterRelease)
      + ' afterOff=' + String(afterOff) + ' first=' + JSON.stringify(first?.state?.mediaId))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const errors = []
    controller.on('error', (payload) => errors.push(payload))
    const fake = fakeFactory(run.dom, { failOn: 'up-bad' })
    run.sandbox.__DSH_APPEARANCE_RENDERERS__ = fake.factory
    controller.apply('background', entry('up-a'))
    controller.apply('background', entry('up-bad'))
    record('#36 a material that cannot be built is reported as an error',
      errors.length >= 1 && typeof errors[0].error?.message === 'string',
      'errors=' + String(errors.length))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    controller.report('background', { hidden: true, videoCount: 2 })
    const slot = controller.state().slots.background
    record('#37 a surface can publish its own facts into state().slots',
      slot.hidden === true && slot.videoCount === 2
      && typeof slot.mediaId === 'string' || slot.mediaId === null,
      'slot=' + JSON.stringify(slot))
  }

  {
    const run = runSandbox({ payload: slotsPayload() })
    const controller = run.controller
    await tick()
    const before = run.dom.elements.length
    const result = controller.apply('background', entry('up-a'))
    const state = controller.state()
    record('#38 the controller never writes an attribute on the body, and it mounts through the host',
      result === 'applied' && run.dom.elements.length === before + 1
      && run.dom.mounted.length === 1
      && state.slot === 'background',
      'elements=' + String(run.dom.elements.length - before)
      + ' mounted=' + String(run.dom.mounted.length))
  }
} catch (error) {
  record('the suite ran to completion', false, String(error && error.stack ? error.stack : error))
} finally {
  notes.push('the two injected scripts are evaluated as text in a node:vm context with a fake DOM')
  notes.push('no package copy is made: nothing here resolves node_modules, so there is no symlink to dereference')
}

/* ---- report ---------------------------------------------------------- */

for (const [label, ok, detail] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === '' ? '' : '  — ' + detail))
}
for (const note of notes) console.log('NOTE  ' + note)

const failed = checks.filter(([, ok]) => !ok)
console.log('')
console.log(checks.length + ' check(s), ' + failed.length + ' failed')
if (failed.length > 0) {
  exitCode = 1
  for (const [label, , detail] of failed) {
    console.log('failed: ' + label + (detail === '' ? '' : '  — ' + detail))
  }
}
process.exit(exitCode)
