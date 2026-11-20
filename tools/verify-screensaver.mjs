#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the idle screensaver surface.
//
// What it proves, and what it deliberately does not:
//
//   * it EVALUATES THE REAL SOURCE TEXT of `src/screensaver.js` — the very
//     bytes the Host pushes into the page — next to the real adapters, the
//     real arbitration point and the real background surface, inside a
//     `node:vm` context with a fake DOM, a fake clock and a fake Host route;
//   * it drives the REAL probe module (`lib/probe.js`) and the REAL idle route
//     (`lib/routes/idle.js`), with an injected runner so every branch —
//     including the two failures — is reachable without a Mac;
//   * it never starts DSH, never binds a port, never opens a browser.
//
// ★ WHY IT EVALUATES THE TEXT INSTEAD OF IMPORTING A MODULE.
//
// The file is SCRIPT TEXT: the Host pushes it into the page as an inline
// `kind:'script'` row. There is no module to import, and there must not be
// one: a `require` in that text is a syntax error in the page.
//
// ★ WHY THE REAL ADAPTERS AND THE REAL ARBITRATION POINT ARE IN THE LOOP.
//
// Two of the contracts this suite asserts span three files: the release order
// (the surface asks the arbitration point to release, the arbitration point
// asks the adapter to dispose, and the adapter is the one that pauses and
// clears the source) and the hand-over (the arbitration point is what brings
// the background back). A fake adapter or a fake arbitration point would let
// the suite assert an order the real code does not have.
//
// ★ EVERY ASSERTION HERE CAN FAIL BECAUSE THE IMPLEMENTATION IS WRONG, AND
// EVERY GROUP HAS A NEGATIVE CONTROL.
//
// A check that has never failed is not a check. So each group is run a second
// time against a deliberately broken COPY of the source, and the broken copy
// MUST produce a different verdict.
//
// ★ THE ANCHORS THROW WHEN THEY DO NOT MATCH.
//
// That is the protection, not an accident: a mutation whose anchor is gone
// would silently do nothing, and the suite would report a green control for a
// change that never happened.
//
// Usage: node tools/verify-screensaver.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

import { createProbe, parseIdleMs } from '../lib/probe.js'
import { buildIdleRoutes, IDLE_PATH } from '../lib/routes/idle.js'

const SAVER_PATH = fileURLToPath(new URL('../src/screensaver.js', import.meta.url))
const RENDERERS_PATH = fileURLToPath(new URL('../src/renderers.js', import.meta.url))
const CONTROLLER_PATH = fileURLToPath(new URL('../src/controller.js', import.meta.url))
const BACKGROUND_PATH = fileURLToPath(new URL('../src/background.js', import.meta.url))

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

/**
 * Let every pending promise settle.
 * @param rounds - how many turns of the microtask queue to allow.
 * @returns a promise.
 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await tick()
}

/* ------------------------------------------------------------------ text */

/** The screensaver surface's source text. */
const SAVER_TEXT = readFileSync(SAVER_PATH, 'utf8')
/** The screensaver surface's source text, comments stripped. */
const SAVER_CODE = stripComments(SAVER_TEXT)
/** The adapters' source text. */
const RENDERERS_TEXT = readFileSync(RENDERERS_PATH, 'utf8')
/** The arbitration point's source text. */
const CONTROLLER_TEXT = readFileSync(CONTROLLER_PATH, 'utf8')
/** The background surface's source text. */
const BACKGROUND_TEXT = readFileSync(BACKGROUND_PATH, 'utf8')

/**
 * Strip the comments out of a source text.
 *
 * ★ A COMMENT IS NOT CODE. This file's own header NAMES the upstream
 * plugin's globals, in the sentence that says they were not used — and a
 * scanner that reads the prose would report a use that is not there.
 *
 * @param text - the source text.
 * @returns the text without its comments.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
}

/**
 * The shapes that must not appear in an injected script.
 * @param text - the source text, comments already stripped.
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
    ['a body attribute write', /document\.body\.(?:setAttribute|removeAttribute|toggleAttribute|dataset|className|classList|style)\b/],
    ['an attribute write of any kind', /\b(?:setAttribute|removeAttribute|toggleAttribute)\b/],
    ['a dataset write', /\bdataset\b/],
    ['an arbitration point of its own', /__DSH_APPEARANCE_CONTROLLER__\s*=[^=]/],
    ["the upstream plugin's globals", /__DSH_BOOT_ANIM/],
    ["the upstream plugin's configuration snapshot", /__DSH_BOOT_ANIM_CFG__/],
    ["the upstream plugin's flat configuration", /screensaver(?:Enabled|IdleMs|BreakEffect|BreakStyle|PointerEffect|Hint|Sound|Volume|RotateMs)\b/],
    ['a negative z-index', /z-index\s*:\s*-\s*\d/],
  ]
  const found = []
  for (const [label, pattern] of shapes) {
    if (pattern.test(text)) found.push(label)
  }
  return found
}

/**
 * Replace one snippet of a source text.
 *
 * ★ THE ANCHOR THROWS WHEN IT DOES NOT MATCH. A mutation that silently did
 * nothing would make a negative control look green for a change that never
 * happened.
 *
 * @param text - the source text.
 * @param from - the anchor.
 * @param to - the replacement.
 * @param what - what the mutation is for, in the error message.
 * @returns the mutated text.
 */
function mutate(text, from, to, what) {
  const index = text.indexOf(from)
  if (index === -1) {
    throw new Error('the anchor for ' + what + ' is not in the source any more: ' + from)
  }
  return text.slice(0, index) + to + text.slice(index + from.length)
}

/* ----------------------------------------------------------------- clock */

/**
 * A fake clock: the wall clock, the monotonic clock and the timers.
 *
 * @returns the clock.
 */
function createClock() {
  const RealDate = Date
  /** The wall clock, in epoch milliseconds. */
  let wall = 1760000000000
  /** The monotonic clock, in milliseconds. */
  let mono = 0
  /** Every pending timer. */
  const timers = new Map()
  /** The next timer id. */
  let nextId = 1
  /** The mutating actions, in order. */
  const calls = []

  /**
   * Record a mutating action.
   * @param name - the action.
   */
  function act(name) {
    calls.push(name)
  }

  /**
   * The fake Date.
   */
  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(wall)
    return new RealDate(...args)
  }
  FakeDate.now = () => wall
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  FakeDate.prototype = RealDate.prototype

  /**
   * Arm a timer.
   * @param fn - the callback.
   * @param ms - the delay.
   * @param repeat - whether it repeats.
   * @returns the timer id.
   */
  function arm(fn, ms, repeat) {
    const id = nextId
    nextId += 1
    const delay = typeof ms === 'number' && isFinite(ms) && ms > 0 ? ms : 0
    timers.set(id, { fn, at: mono + delay, every: repeat ? delay : null })
    return id
  }

  return {
    calls,
    get wall() { return wall },
    get mono() { return mono },
    Date: FakeDate,
    performance: { now: () => mono },
    setTimeout: (fn, ms) => arm(fn, ms, false),
    setInterval: (fn, ms) => arm(fn, ms, true),
    clearTimeout: (id) => {
      if (id === undefined || id === null) return
      if (timers.has(id)) {
        act('clearTimer')
        timers.delete(id)
      }
    },
    clearInterval: (id) => {
      if (id === undefined || id === null) return
      if (timers.has(id)) {
        act('clearTimer')
        timers.delete(id)
      }
    },
    requestAnimationFrame: (fn) => arm((ts) => fn(ts), 16, false),
    cancelAnimationFrame: (id) => {
      if (id === undefined || id === null) return
      timers.delete(id)
    },
    /**
     * Move the clock forward and run everything that comes due.
     * @param ms - how far.
     */
    advance(ms) {
      const target = mono + ms
      let guard = 0
      for (;;) {
        guard += 1
        if (guard > 10000) throw new Error('the fake clock ran away')
        let next = null
        let nextId2 = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (next === null || timer.at < next.at || (timer.at === next.at && id < nextId2)) {
            next = timer
            nextId2 = id
          }
        }
        if (next === null) break
        mono = next.at
        wall += Math.max(0, next.at - (mono - (next.at - (next.at - mono))))
        if (next.every === null) {
          timers.delete(nextId2)
        } else {
          next.at = mono + next.every
        }
        try {
          next.fn(mono)
        } catch (error) {
          // A throwing timer must not stop the clock.
          act('timer-threw:' + String(error && error.message ? error.message : error))
        }
      }
      mono = target
      wall += ms
    },
    /**
     * How many timers are armed.
     * @returns the count.
     */
    pending() {
      return timers.size
    },
  }
}

/* -------------------------------------------------------------- fake DOM */

/**
 * A fake DOM: elements, a body, a head, a MutationObserver and a canvas.
 *
 * @param options - `{ calls, noBody, chatRunning }`.
 * @returns the DOM.
 */
function createFakeDom(options = {}) {
  /** The mutating actions, in order. */
  const calls = options.calls ?? []
  /** The reads, in order. */
  const reads = []
  /** Every element that was created. */
  const elements = []
  /** Every observer that was armed. */
  const observers = []
  /** The warnings the surface printed. */
  const warnings = []
  /** The fetches the page made. */
  const fetches = []

  /**
   * Record a mutating action.
   * @param name - the action.
   */
  function act(name) {
    calls.push(name)
  }

  /**
   * Record a read.
   * @param name - the read.
   */
  function look(name) {
    reads.push(name)
  }

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
        act(name + (name === 'src' ? ':' + String(next) : ''))
        value = next
      },
    })
  }

  /**
   * Collect the elements that match a tag name.
   * @param root - the root element.
   * @param selector - the tag name.
   * @returns the matching elements.
   */
  function collect(root, selector) {
    const found = []
    const walk = (node) => {
      if (node.tagName === String(selector).toUpperCase()) found.push(node)
      for (const child of node.children ?? []) walk(child)
    }
    walk(root)
    return found
  }

  /**
   * Detach an element from its parent, quietly.
   * @param element - the element.
   */
  function detach(element) {
    const parent = element.parentNode
    if (parent !== undefined && parent !== null && Array.isArray(parent.children)) {
      const index = parent.children.indexOf(element)
      if (index >= 0) parent.children.splice(index, 1)
    }
    element.parentNode = null
  }

  /**
   * A canvas 2d context that accepts everything.
   * @returns the context.
   */
  function makeContext() {
    return {
      globalAlpha: 1,
      strokeStyle: '',
      lineWidth: 1,
      drawImage() {},
      clearRect() {},
      fillRect() {},
      beginPath() {},
      arc() {},
      stroke() {},
      fill() {},
    }
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
      textContent: '',
      style: {},
      attributes: {},
      parentNode: null,
      children: [],
      listeners,
      clientWidth: 1280,
      clientHeight: 800,
      paused: true,
      ended: false,
      readyState: 0,
      currentTime: 0,
      duration: Number.NaN,
      complete: false,
      naturalWidth: 0,
      error: null,
      classList: { add() {}, remove() {} },
      setAttribute(name, value) {
        act('setAttribute:' + name)
        element.attributes[name] = String(value)
      },
      removeAttribute(name) {
        act('removeAttribute:' + name)
        delete element.attributes[name]
        // ★ THE SOURCE PROPERTY REALLY GOES.
        if (name === 'src') element.src = ''
      },
      getAttribute(name) {
        look('getAttribute:' + name)
        return element.attributes[name]
      },
      hasAttribute(name) {
        look('hasAttribute:' + name)
        return Object.prototype.hasOwnProperty.call(element.attributes, name)
      },
      appendChild(child) {
        act('append:' + child.tagName)
        element.children.push(child)
        child.parentNode = element
        return child
      },
      removeChild(child) {
        act('removeChild:' + child.tagName)
        detach(child)
        return child
      },
      remove() {
        act('remove:' + element.tagName)
        detach(element)
      },
      addEventListener(type, fn) {
        act('addEventListener:' + type)
        if (listeners[type] === undefined) listeners[type] = []
        listeners[type].push(fn)
      },
      removeEventListener(type, fn) {
        act('removeEventListener:' + type)
        const list = listeners[type] === undefined ? [] : listeners[type]
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      },
      dispatch(type, event) {
        const list = (listeners[type] === undefined ? [] : listeners[type]).slice()
        for (const fn of list) fn(event ?? { type })
      },
      play() {
        act('play')
        element.paused = false
        element.readyState = 2
        return Promise.resolve()
      },
      pause() {
        act('pause')
        element.paused = true
      },
      load() {
        act('load')
      },
      getContext() {
        return makeContext()
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }
      },
      querySelectorAll(selector) {
        look('querySelectorAll:' + selector)
        return collect(element, selector)
      },
    }
    defineRecorded(element, 'src', '')
    defineRecorded(element, 'muted', false)
    defineRecorded(element, 'loop', false)
    defineRecorded(element, 'volume', 1)
    elements.push(element)
    act('create:' + element.tagName)
    return element
  }

  /**
   * The body. It accepts children and it carries the other plugin's marker.
   */
  const body = {
    tagName: 'BODY',
    className: '',
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    listeners: {},
    appendChild(child) {
      act('append:' + child.tagName)
      body.children.push(child)
      child.parentNode = body
      return child
    },
    removeChild(child) {
      act('removeChild:' + child.tagName)
      const index = body.children.indexOf(child)
      if (index >= 0) body.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    getAttribute(name) {
      look('getAttribute:' + name)
      return body.attributes[name]
    },
    setAttribute(name, value) {
      act('body.setAttribute:' + name)
      body.attributes[name] = String(value)
      for (const observer of observers) observer.trigger()
    },
    removeAttribute(name) {
      act('body.removeAttribute:' + name)
      delete body.attributes[name]
      for (const observer of observers) observer.trigger()
    },
    querySelectorAll(selector) {
      look('querySelectorAll:' + selector)
      return collect(body, selector)
    },
  }

  const head = {
    tagName: 'HEAD',
    children: [],
    parentNode: null,
    appendChild(child) {
      act('append:' + child.tagName)
      head.children.push(child)
      child.parentNode = head
      return child
    },
    removeChild(child) {
      act('removeChild:' + child.tagName)
      const index = head.children.indexOf(child)
      if (index >= 0) head.children.splice(index, 1)
      child.parentNode = null
      return child
    },
  }

  const documentListeners = {}
  const document = {
    body: options.noBody === true ? null : body,
    head,
    documentElement: head,
    visibilityState: 'visible',
    hidden: false,
    createElement,
    addEventListener(type, fn) {
      act('doc.addEventListener:' + type)
      if (documentListeners[type] === undefined) documentListeners[type] = []
      documentListeners[type].push(fn)
    },
    removeEventListener(type, fn) {
      act('doc.removeEventListener:' + type)
      const list = documentListeners[type] === undefined ? [] : documentListeners[type]
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatch(type, event) {
      const list = (documentListeners[type] === undefined ? [] : documentListeners[type]).slice()
      for (const fn of list) fn(event ?? { type })
    },
    querySelector(selector) {
      look('querySelector:' + selector)
      if (options.chatRunning === true && String(selector).includes('data-chat-running')) {
        return { tagName: 'DIV' }
      }
      return null
    },
    querySelectorAll(selector) {
      look('querySelectorAll:' + selector)
      return collect(body, selector)
    },
  }

  const windowListeners = {}
  const window = {
    addEventListener(type, fn) {
      act('window.addEventListener:' + type)
      if (windowListeners[type] === undefined) windowListeners[type] = []
      windowListeners[type].push(fn)
    },
    removeEventListener(type, fn) {
      act('window.removeEventListener:' + type)
      const list = windowListeners[type] === undefined ? [] : windowListeners[type]
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatch(type, event) {
      const list = (windowListeners[type] === undefined ? [] : windowListeners[type]).slice()
      for (const fn of list) fn(event ?? { type })
    },
  }

  /**
   * The MutationObserver. It fires when the body's attributes change.
   */
  class FakeMutationObserver {
    /**
     * @param callback - the callback.
     */
    constructor(callback) {
      this.callback = callback
      this.target = null
      observers.push(this)
    }

    /**
     * @param target - what to watch.
     * @param observerOptions - the options.
     */
    observe(target, observerOptions) {
      this.target = target
      this.options = observerOptions
    }

    /** Stop watching. */
    disconnect() {
      act('disconnect')
      this.target = null
    }

    /** Fire the callback. */
    trigger() {
      if (this.target === null) return
      this.callback([{ type: 'attributes' }], this)
    }
  }

  /**
   * The routes the page can fetch.
   */
  const routes = new Map()

  /**
   * The fake fetch.
   * @param url - the URL.
   * @param init - the options.
   * @returns a promise for the response.
   */
  function fetch(url, init) {
    const address = String(url)
    fetches.push({ url: address, cache: init && init.cache ? init.cache : null })
    const handler = routes.get(address)
    if (handler === undefined) {
      return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('no route')) })
    }
    if (handler === 'hang') {
      return new Promise(() => {})
    }
    const value = typeof handler === 'function' ? handler() : handler
    return Promise.resolve({ ok: true, json: () => Promise.resolve(value) })
  }

  return {
    calls,
    reads,
    elements,
    observers,
    warnings,
    fetches,
    document,
    window,
    body,
    head,
    routes,
    fetch,
    MutationObserver: FakeMutationObserver,
    /**
     * How many of our own elements are on the page.
     *
     * ★ ONLY THE ELEMENTS INSIDE OUR OWN LAYER COUNT. The other surfaces have
     * their own videos, and a video of theirs is not a leftover of ours.
     * @returns the counts.
     */
    leftovers() {
      let layers = 0
      let styles = 0
      let videos = 0
      let canvases = 0
      const walk = (node, inside) => {
        const ours = inside
          || String(node.className).includes('dsham-saver-layer')
          || String(node.className).includes('dsham-saver-stage')
        if (String(node.className).includes('dsham-saver-layer')) layers += 1
        if (node.tagName === 'STYLE' && String(node.textContent).includes('dsham-saver-layer')) styles += 1
        if (ours && node.tagName === 'VIDEO') videos += 1
        if (ours && node.tagName === 'CANVAS') canvases += 1
        for (const child of node.children ?? []) walk(child, ours)
      }
      walk(body, false)
      walk(head, false)
      return { layers, styles, videos, canvases }
    },
  }
}

/* --------------------------------------------------------------- fixtures */

/**
 * One catalog entry.
 * @param id - the id.
 * @param name - the file name.
 * @param kind - the kind.
 * @returns the entry.
 */
function entry(id, name, kind = 'video') {
  return { id, name, kind, mediaUrl: '/appearance-media/media/' + id }
}

/**
 * The slot configuration the fake Host answers with.
 * @param options - the overrides.
 * @returns the payload.
 */
function slotsPayload(options = {}) {
  const screensaver = {
    enabled: options.enabled !== false,
    mediaId: options.mediaId === undefined ? 'up-saver' : options.mediaId,
    revision: options.revision ?? 1,
  }
  const background = {
    enabled: options.backgroundEnabled !== false,
    mediaId: options.backgroundMediaId === undefined ? 'up-bg' : options.backgroundMediaId,
    revision: options.backgroundRevision ?? 1,
  }
  const boot = { enabled: false, mediaId: null, revision: 0 }
  return {
    ok: true,
    config: {
      revision: options.revision ?? 1,
      slots: { background, boot, screensaver },
      options: {
        background: { surface: 0, muted: true, pauseWhenHidden: true },
        boot: { muted: true, fadeMs: 2000, holdMs: 15000 },
        screensaver: {
          idleMs: options.idleMs ?? 30000,
          volume: options.volume ?? 0,
          muted: options.muted !== false,
          breakEffect: options.breakEffect === true,
          breakStyle: options.breakStyle ?? 'particles',
          pointerEffect: options.pointerEffect === true,
          pointerStyle: options.pointerStyle ?? 'ripples',
          hint: options.hint !== false,
          rotateMs: options.rotateMs ?? 0,
        },
      },
    },
    ignored: [],
  }
}

/**
 * The material library the fake Host answers with.
 * @param entries - the entries.
 * @returns the payload.
 */
function catalogPayload(entries) {
  return { ok: true, revision: 1, entries }
}

/* --------------------------------------------------------------- sandbox */

/**
 * Run the surface in a sandbox.
 *
 * @param options - the seams.
 * @returns the sandbox handle.
 */
function runSandbox(options = {}) {
  const clock = createClock()
  const dom = createFakeDom({ calls: clock.calls, noBody: options.noBody, chatRunning: options.chatRunning })
  const entries = options.entries ?? [
    entry('up-saver', 'saver-1.mp4'),
    entry('up-saver-2', 'saver-2.mp4'),
    entry('up-bg', 'background-1.mp4'),
  ]
  dom.routes.set('/appearance-media/slots', options.slots ?? (() => slotsPayload({
    ...(options.slotsOptions ?? {}),
    // ★ THE BACKGROUND SLOT IS ON WHENEVER THE BACKGROUND SURFACE IS IN THE
    // SANDBOX — the hand-over needs a slot to hand back to.
    backgroundEnabled: options.background === true ? true : (options.slotsOptions?.backgroundEnabled ?? false),
  })))
  dom.routes.set('/appearance-media/catalog.json', options.catalog ?? (() => catalogPayload(entries)))
  dom.routes.set('/appearance-media/system-idle.json', options.idle ?? (() => ({
    ok: true, idleMs: options.idleMs ?? 120000, status: 'ok', reason: 'ok',
  })))

  const context = {
    console: {
      warn: (message) => dom.warnings.push(String(message)),
      log: () => {},
      error: () => {},
    },
    document: dom.document,
    window: dom.window,
    MutationObserver: dom.MutationObserver,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    Date: clock.Date,
    performance: clock.performance,
    devicePixelRatio: 1,
    fetch: dom.fetch,
    Promise,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    isFinite,
    parseInt,
    parseFloat,
  }

  vm.createContext(context)
  const sources = options.sources ?? {}
  vm.runInContext(sources.renderers ?? RENDERERS_TEXT, context, { filename: 'renderers.js' })
  vm.runInContext(sources.controller ?? CONTROLLER_TEXT, context, { filename: 'controller.js' })
  if (options.background === true) {
    vm.runInContext(sources.background ?? BACKGROUND_TEXT, context, { filename: 'background.js' })
  }
  vm.runInContext(sources.screensaver ?? SAVER_TEXT, context, { filename: 'screensaver.js' })

  const controller = context.__DSH_APPEARANCE_CONTROLLER__
  const surface = context.__DSH_APPEARANCE_SCREENSAVER__
  const spy = { apply: [], release: [], displace: [], restore: [] }
  if (controller !== undefined && controller !== null) {
    const originalApply = controller.apply
    const originalRelease = controller.release
    const originalDisplace = controller.displace
    const originalRestore = controller.restore
    controller.apply = function (...args) {
      spy.apply.push({ slot: args[0], at: spy.apply.length })
      return originalApply.apply(this, args)
    }
    controller.release = function (...args) {
      spy.release.push({ slot: args[0], at: spy.release.length })
      return originalRelease.apply(this, args)
    }
    controller.displace = function (...args) {
      spy.displace.push({ slot: args[0], at: spy.displace.length })
      return originalDisplace.apply(this, args)
    }
    controller.restore = function (...args) {
      spy.restore.push({ at: spy.restore.length })
      return originalRestore.apply(this, args)
    }
  }

  return { context, dom, clock, controller, surface, spy }
}

/**
 * Bring the screensaver up in a sandbox.
 *
 * @param run - the sandbox handle.
 * @returns a promise.
 */
async function bringUp(run) {
  await settle()
  run.clock.advance(2000)
  await settle()
}

/* --------------------------------------------------------- release order */

/**
 * Read the release order out of the action log.
 *
 * @param calls - the action log.
 * @returns the indices, or -1 for a step that did not happen.
 */
function releaseOrder(calls) {
  const from = (marker, after) => {
    for (let i = after; i < calls.length; i += 1) {
      if (calls[i] === marker) return i
    }
    return -1
  }
  const pause = from('pause', 0)
  const clearSrc = from('removeAttribute:src', pause + 1)
  const unbind = from('removeEventListener:loadeddata', clearSrc + 1)
  // ★ THE SURFACE'S OWN LISTENERS ARE BOUND ON THE DOCUMENT, so the marker
  // carries the document's prefix.
  const unbindOwn = from('doc.removeEventListener:keydown', unbind + 1)
  const disconnect = from('disconnect', unbindOwn + 1)
  const clearTimer = from('clearTimer', disconnect + 1)
  let removeFirst = -1
  for (let i = clearTimer + 1; i < calls.length; i += 1) {
    if (String(calls[i]).startsWith('remove:')) {
      removeFirst = i
      break
    }
  }
  let removeLast = -1
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (String(calls[i]).startsWith('remove:')) {
      removeLast = i
      break
    }
  }
  return { pause, clearSrc, unbind, unbindOwn, disconnect, clearTimer, removeFirst, removeLast }
}

/* ====================================================================== */
/*  1 · the shape of the injected text                                      */
/* ====================================================================== */

{
  const shapes = forbiddenShapes(SAVER_CODE)
  record('#1 the screensaver source is plain script text with no forbidden shape',
    shapes.length === 0, JSON.stringify(shapes))

  record('#2 the surface publishes its own global and creates no arbitration point',
    typeof globalThis !== 'undefined'
      && /globalThis\.__DSH_APPEARANCE_SCREENSAVER__\s*=/.test(SAVER_CODE)
      && !/__DSH_APPEARANCE_CONTROLLER__\s*=[^=]/.test(SAVER_CODE),
    'published=' + /globalThis\.__DSH_APPEARANCE_SCREENSAVER__\s*=/.test(SAVER_CODE)
      + ' ownPoint=' + /__DSH_APPEARANCE_CONTROLLER__\s*=[^=]/.test(SAVER_CODE))

  // ★★ THE OTHER PLUGINS' MARKERS ARE READ AND NEVER WRITTEN.
  //
  // Two markers, from two plugins: `data-we-wallpaper` on the body and
  // `data-dsvs-background` on the root element. The screensaver stands on
  // the same stage as the background, so it has to yield for the same
  // reasons — and it must never touch a marker that belongs to somebody
  // else.
  //
  // ★ THE COMMENTS ARE STRIPPED FIRST: a prose mention is not a use.
  {
    const code = SAVER_CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const total = (code.match(/data-we-wallpaper/g) ?? []).length
      + (code.match(/data-dsvs-background/g) ?? []).length
    const reads = (code.match(/(?:getAttribute|hasAttribute)\(\s*'data-we-wallpaper'\s*\)/g) ?? []).length
      + (code.match(/(?:getAttribute|hasAttribute)\(\s*'data-dsvs-background'\s*\)/g) ?? []).length
    const writes = /setAttribute\(\s*'(?:data-we-wallpaper|data-dsvs-background)'/.test(code)
    record('#3b the other plugins\' markers are READ and never written',
      total > 0 && total === reads && !writes,
      'total=' + String(total) + ' reads=' + String(reads) + ' writes=' + String(writes))
  }

  // ★ NO CONFIGURATION VALUE IS BAKED INTO THE TEXT. The fixture's values are
  // distinctive on purpose: 31415 and 27182 do not occur in the source.
  const baked = ['31415', '27182', '987654'].filter((value) => SAVER_TEXT.includes(value))
  record('#3 no configuration value is baked into the injected text',
    baked.length === 0 && !/__DSH_APPEARANCE_SCREENSAVER_CFG__/.test(SAVER_CODE),
    'baked=' + JSON.stringify(baked))

  const urls = [...SAVER_CODE.matchAll(/'(\/appearance-media\/[^']*)'/g)].map((m) => m[1])
  record('#4 the surface reads the slot route, the material library and the idle route',
    urls.includes('/appearance-media/slots')
      && urls.includes('/appearance-media/catalog.json')
      && urls.includes('/appearance-media/system-idle.json'),
    JSON.stringify([...new Set(urls)]))

  record('#5 the ported code keeps its copyright notice',
    SAVER_TEXT.includes('Copyright (c) 2026 dsh-boot-animation contributors'),
    'attribution=' + SAVER_TEXT.includes('Copyright (c) 2026 dsh-boot-animation contributors'))

  record('#6 the surface does not mention the upstream plugin\'s flat configuration',
    !/screensaver(?:Enabled|IdleMs|BreakEffect|BreakStyle|PointerEffect|Hint|Sound|Volume|RotateMs)\b/.test(SAVER_CODE),
    'flat=' + /screensaver(?:Enabled|IdleMs|BreakEffect|BreakStyle|PointerEffect|Hint|Sound|Volume|RotateMs)\b/.test(SAVER_CODE))
}

/* ====================================================================== */
/*  2 · the trigger, rule by rule                                           */
/* ====================================================================== */

{
  const run = runSandbox()
  const decide = run.surface.decide
  const base = {
    enabled: true,
    dismissed: false,
    bootOnStage: false,
    hiddenMs: 0,
    turnRunning: false,
    idleStatus: 'ok',
    idleMs: 600000,
    thresholdMs: 30000,
    blurredMs: 0,
  }
  const verdict = (patch) => decide({ ...base, ...patch })

  record('#7 the trigger shows when every condition holds',
    verdict({}).show === true, JSON.stringify(verdict({})))

  record('#8 rule ① — the slot is off ⇒ never show',
    verdict({ enabled: false }).show === false
      && verdict({ enabled: false }).blockedBy === 'disabled',
    JSON.stringify(verdict({ enabled: false })))

  record('#9 rule ② — a dismissal holds ⇒ never show',
    verdict({ dismissed: true }).show === false
      && verdict({ dismissed: true }).blockedBy === 'dismissed',
    JSON.stringify(verdict({ dismissed: true })))

  record('#10 rule ③ — the boot clip is on the stage ⇒ never show',
    verdict({ bootOnStage: true }).show === false
      && verdict({ bootOnStage: true }).blockedBy === 'boot-on-stage',
    JSON.stringify(verdict({ bootOnStage: true })))

  record('#11 rule ④ — hidden for 4999 ms ⇒ the later rules still decide',
    verdict({ hiddenMs: 4999 }).show === true,
    JSON.stringify(verdict({ hiddenMs: 4999 })))

  record('#12 rule ④ — hidden for 5000 ms ⇒ never show',
    verdict({ hiddenMs: 5000 }).show === false
      && verdict({ hiddenMs: 5000 }).blockedBy === 'hidden',
    JSON.stringify(verdict({ hiddenMs: 5000 })))

  record('#13 rule ⑤ — a Turn is running ⇒ never show',
    verdict({ turnRunning: true }).show === false
      && verdict({ turnRunning: true }).blockedBy === 'turn-running',
    JSON.stringify(verdict({ turnRunning: true })))

  record('#14 rule ⑥ — an idle reading at the threshold ⇒ show',
    verdict({ idleMs: 30000, blurredMs: 0 }).show === true,
    JSON.stringify(verdict({ idleMs: 30000, blurredMs: 0 })))

  record('#15 rule ⑦ — the focus half alone ⇒ show',
    verdict({ idleStatus: 'unavailable', idleMs: null, blurredMs: 30000 }).show === true,
    JSON.stringify(verdict({ idleStatus: 'unavailable', idleMs: null, blurredMs: 30000 })))

  record('#16 rules ⑥ and ⑦ are ORed with each other',
    verdict({ idleMs: 600000, blurredMs: 0 }).show === true
      && verdict({ idleStatus: 'unavailable', idleMs: null, blurredMs: 60000 }).show === true
      && verdict({ idleStatus: 'unavailable', idleMs: null, blurredMs: 0 }).show === false,
    'idleOnly=' + verdict({ idleMs: 600000, blurredMs: 0 }).show
      + ' blurOnly=' + verdict({ idleStatus: 'unavailable', idleMs: null, blurredMs: 60000 }).show)

  record('#17 \'starting\' is NOT idle — only \'ok\' counts',
    verdict({ idleStatus: 'starting', idleMs: 600000, blurredMs: 0 }).show === false,
    JSON.stringify(verdict({ idleStatus: 'starting', idleMs: 600000, blurredMs: 0 })))

  record('#18 \'unavailable\' is NOT idle — only \'ok\' counts',
    verdict({ idleStatus: 'unavailable', idleMs: 600000, blurredMs: 0 }).show === false,
    JSON.stringify(verdict({ idleStatus: 'unavailable', idleMs: 600000, blurredMs: 0 })))

  record('#19 the idle reading below the threshold does not show',
    verdict({ idleMs: 29999, blurredMs: 0 }).show === false,
    JSON.stringify(verdict({ idleMs: 29999, blurredMs: 0 })))

  record('#20 the rules are evaluated IN ORDER — the first one that objects wins',
    verdict({ enabled: false, dismissed: true, bootOnStage: true }).blockedBy === 'disabled'
      && verdict({ dismissed: true, bootOnStage: true }).blockedBy === 'dismissed'
      && verdict({ bootOnStage: true, turnRunning: true }).blockedBy === 'boot-on-stage'
      && verdict({ turnRunning: true, hiddenMs: 0 }).blockedBy === 'turn-running'
      && verdict({ turnRunning: true, hiddenMs: 5000 }).blockedBy === 'hidden',
    'disabled=' + verdict({ enabled: false, dismissed: true, bootOnStage: true }).blockedBy
      + ' dismissed=' + verdict({ dismissed: true, bootOnStage: true }).blockedBy
      + ' boot=' + verdict({ bootOnStage: true, turnRunning: true }).blockedBy
      + ' turn=' + verdict({ turnRunning: true, hiddenMs: 0 }).blockedBy
      + ' hiddenBeforeTurn=' + verdict({ turnRunning: true, hiddenMs: 5000 }).blockedBy)

  record('#21 the trigger is ONE function, and the live path uses it',
    typeof run.surface.decide === 'function' && typeof run.surface.readings === 'function',
    'decide=' + typeof run.surface.decide + ' readings=' + typeof run.surface.readings)
}

/* ====================================================================== */
/*  3 · the three states of the idle probe                                   */
/* ====================================================================== */

{
  const good = '  "HIDIdleTime" = 1234567890\n'
  record('#22 the idle time is parsed out of the ioreg answer',
    parseIdleMs(good) === 1235, String(parseIdleMs(good)))

  const notDarwin = await createProbe({ platform: 'linux', run: async () => ({ ok: true, stdout: good }) }).read()
  record('#23 off Darwin the probe answers \'unavailable\' and idleMs is NOT a number',
    notDarwin.status === 'unavailable' && typeof notDarwin.idleMs !== 'number',
    JSON.stringify(notDarwin))

  const missing = await createProbe({
    platform: 'darwin',
    run: async () => ({ ok: false, stdout: '', stderr: '', exitCode: null, timedOut: false, errno: 'ENOENT' }),
  }).read()
  record('#24 a missing ioreg answers \'unavailable\' and idleMs is NOT a number',
    missing.status === 'unavailable' && typeof missing.idleMs !== 'number',
    JSON.stringify(missing))

  const timedOut = await createProbe({
    platform: 'darwin',
    run: async () => ({ ok: false, stdout: '', stderr: '', exitCode: null, timedOut: true, errno: null }),
  }).read()
  record('#25 a timed-out read answers \'starting\' and idleMs is NOT a number',
    timedOut.status === 'starting' && typeof timedOut.idleMs !== 'number',
    JSON.stringify(timedOut))

  const noCounter = await createProbe({
    platform: 'darwin',
    run: async () => ({ ok: true, stdout: 'no counter here', stderr: '', exitCode: 0, timedOut: false, errno: null }),
  }).read()
  record('#26 an answer without the counter answers \'unavailable\' and idleMs is NOT a number',
    noCounter.status === 'unavailable' && typeof noCounter.idleMs !== 'number',
    JSON.stringify(noCounter))

  const goodRead = await createProbe({
    platform: 'darwin',
    run: async () => ({ ok: true, stdout: good, stderr: '', exitCode: 0, timedOut: false, errno: null }),
  }).read()
  record('#27 a reading answers \'ok\' and the milliseconds',
    goodRead.status === 'ok' && goodRead.ok === true && goodRead.idleMs === 1235,
    JSON.stringify(goodRead))

  // ★ THE SHAPE THAT MUST NEVER HAPPEN: a failure flattened into a zero.
  const failures = [notDarwin, missing, timedOut, noCounter]
  const zeroed = failures.filter((answer) => answer.idleMs === 0)
  record('#28 a failure is NEVER flattened into idleMs: 0',
    zeroed.length === 0, JSON.stringify(failures.map((answer) => [answer.status, answer.idleMs])))

  // ★ THE ROUTE.
  const route = buildIdleRoutes({ readIdle: async () => notDarwin })[0]
  const answers = []
  const res = {
    headersSent: false,
    writeHead(status, headers) { answers.push({ status, headers, body: null }); this.headersSent = true },
    end(body) { answers[answers.length - 1].body = body },
  }
  await route.handler({ method: 'GET' }, res)
  const payload = JSON.parse(String(answers[0].body))
  record('#29 the idle route answers 200 with the three states',
    answers[0].status === 200 && payload.status === 'unavailable' && payload.idleMs === null
      && answers[0].headers['Cache-Control'] === 'no-store',
    JSON.stringify(payload))

  const refused = []
  const res2 = {
    headersSent: false,
    writeHead(status, headers) { refused.push({ status, headers, body: null }); this.headersSent = true },
    end(body) { refused[refused.length - 1].body = body },
  }
  await route.handler({ method: 'POST' }, res2)
  record('#30 the idle route is GET-only',
    refused[0].status === 405 && String(refused[0].headers.Allow).includes('GET'),
    JSON.stringify(refused[0]))
}

/* ====================================================================== */
/*  4 · the live path                                                      */
/* ====================================================================== */

{
  const run = runSandbox()
  await bringUp(run)
  const facts = run.surface.state()
  record('#31 the live path brings the layer up when the trigger holds',
    facts.visible === true && facts.layer === true && facts.media === true,
    JSON.stringify({ visible: facts.visible, layer: facts.layer, media: facts.media }))

  const left = run.dom.leftovers()
  record('#32 the layer, the style and the media are on the page',
    left.layers === 1 && left.styles === 1 && left.videos === 1,
    JSON.stringify(left))

  const media = run.dom.body.children[0]?.children?.[0]?.children?.find((child) => child.tagName === 'VIDEO')
  record('#33 the screensaver media LOOPS — a clip that stops freezes the screen',
    media !== undefined && media.loop === true,
    'loop=' + String(media?.loop))

  const fetches = run.dom.fetches.map((entry2) => entry2.url)
  const caches = run.dom.fetches.map((entry2) => entry2.cache)
  record('#34 the configuration and the idle reading are read live, and never cached',
    fetches.includes('/appearance-media/slots')
      && fetches.includes('/appearance-media/system-idle.json')
      && fetches.includes('/appearance-media/catalog.json')
      && caches.every((cache) => cache === 'no-store'),
    JSON.stringify([...new Set(fetches)]) + ' caches=' + JSON.stringify([...new Set(caches)]))

  const mediaUrl = media?.src
  record('#35 the media URL comes from the library entry, never from a hand-written path',
    String(mediaUrl).includes('/appearance-media/media/up-saver'),
    'src=' + String(mediaUrl))
}

/* ====================================================================== */
/*  5 · the three states are not idle, in the live path                     */
/* ====================================================================== */

{
  const run = runSandbox({
    idle: () => ({ ok: false, idleMs: null, status: 'starting', reason: 'probe-error' }),
  })
  await bringUp(run)
  const facts = run.surface.state()
  record('#36 a \'starting\' reading does not bring the layer up',
    facts.visible === false && facts.layer === false && facts.idleStatus === 'starting',
    JSON.stringify({ visible: facts.visible, idleStatus: facts.idleStatus }))
}

{
  const run = runSandbox({
    idle: () => ({ ok: false, idleMs: null, status: 'unavailable', reason: 'not-darwin' }),
  })
  await bringUp(run)
  const facts = run.surface.state()
  record('#37 an \'unavailable\' reading does not bring the layer up',
    facts.visible === false && facts.layer === false && facts.idleStatus === 'unavailable',
    JSON.stringify({ visible: facts.visible, idleStatus: facts.idleStatus }))
}

/* ====================================================================== */
/*  6 · the dismissal holds                                                 */
/* ====================================================================== */

{
  const run = runSandbox({ background: true })
  await bringUp(run)
  const before = run.surface.state()
  record('#38 the layer is up before the dismissal', before.visible === true, JSON.stringify(before.visible))

  // ★ THE USER DISMISSES IT. The break effect is off in this fixture, so the
  // dismissal is a plain fade.
  run.surface.release()
  run.clock.advance(600)
  await settle()
  const after = run.surface.state()
  record('#39 a dismissal takes the layer down',
    after.visible === false && after.dismissed === true,
    JSON.stringify({ visible: after.visible, dismissed: after.dismissed }))

  const left = run.dom.leftovers()
  const media = run.dom.body.children[0]?.children?.[0]?.children?.find((child) => child.tagName === 'VIDEO')
  record('#40 a dismissal leaves no video, no layer and no style behind',
    left.videos === 0 && left.layers === 0 && left.styles === 0
      && (media === undefined || media.parentNode === null),
    JSON.stringify(left) + ' detached=' + String(media === undefined || media.parentNode === null))

  // ★ AND IT DOES NOT COME BACK while the machine is idle.
  run.clock.advance(2000)
  await settle()
  const again = run.surface.state()
  record('#41 a dismissed screensaver does not come back on its own',
    again.visible === false && again.dismissed === true,
    JSON.stringify({ visible: again.visible, dismissed: again.dismissed }))
}

/* ====================================================================== */
/*  7 · the release                                                         */
/* ====================================================================== */

{
  const run = runSandbox()
  await bringUp(run)
  const callsBefore = run.clock.calls.length
  run.surface.dispose()
  await settle()
  const order = releaseOrder(run.clock.calls.slice(callsBefore))
  const ordered = order.pause >= 0
    && order.pause < order.clearSrc
    && order.clearSrc < order.unbind
    && order.unbind < order.unbindOwn
    && order.unbindOwn < order.disconnect
    && order.disconnect < order.clearTimer
    && order.clearTimer < order.removeFirst
    && order.removeFirst < order.removeLast
  record('#42 the release order is pause, clear the source, unbind, disconnect, clear the timer, remove',
    ordered,
    'pause=' + order.pause + ' clearSrc=' + order.clearSrc + ' unbind=' + order.unbind
      + ' unbindOwn=' + order.unbindOwn + ' disconnect=' + order.disconnect
      + ' clearTimer=' + order.clearTimer + ' removeFirst=' + order.removeFirst
      + ' removeLast=' + order.removeLast)

  const left = run.dom.leftovers()
  record('#43 after the release not one of our elements is left on the page',
    left.videos === 0 && left.layers === 0 && left.styles === 0 && left.canvases === 0,
    JSON.stringify(left))

  const facts = run.surface.state()
  record('#44 after the release the watcher is gone too',
    facts.visible === false && facts.layer === false && facts.media === false,
    JSON.stringify({ visible: facts.visible, layer: facts.layer, media: facts.media }))
}

{
  // ★ THE QUIET STAND-DOWN. The trigger stops holding ⇒ the layer goes, and
  // the WATCHER STAYS so the layer can come back.
  const run = runSandbox()
  await bringUp(run)
  run.dom.routes.set('/appearance-media/system-idle.json', () => ({
    ok: true, idleMs: 10, status: 'ok', reason: 'ok',
  }))
  run.clock.advance(2000)
  await settle()
  const left = run.dom.leftovers()
  const facts = run.surface.state()
  record('#45 when the trigger stops holding the layer, the style and the media go',
    left.videos === 0 && left.layers === 0 && left.styles === 0 && facts.visible === false,
    JSON.stringify(left) + ' visible=' + String(facts.visible))
}

/* ====================================================================== */
/*  8 · the host belongs to the surface                                     */
/* ====================================================================== */

{
  // ★ THE HOST OWNERSHIP. The arbitration point asks the surface for its host
  // BEFORE it mounts anything — and it may be the one asking, not the
  // surface (that is how a pushed-off slot comes back, and it is what the
  // client half does).
  const run = runSandbox({ noBody: true })
  await settle()
  const result = run.controller.apply('screensaver', entry('up-saver', 'saver-1.mp4'))
  const left = run.dom.leftovers()
  record('#46 a surface that cannot give a host fails loudly — the material never lands on the body',
    result === 'failed-kept-previous' && left.videos === 0,
    'result=' + String(result) + ' videos=' + String(left.videos))

  const run2 = runSandbox()
  await bringUp(run2)
  const media = run2.dom.body.children[0]?.children?.[0]?.children?.find((child) => child.tagName === 'VIDEO')
  const onBody = run2.dom.body.children.some((child) => child.tagName === 'VIDEO')
  record('#47 the material is mounted INSIDE the surface\'s own layer, never on the body',
    media !== undefined && onBody === false,
    'inside=' + String(media !== undefined) + ' onBody=' + String(onBody))
}

/* ====================================================================== */
/*  9 · the hand-over                                                       */
/* ====================================================================== */

{
  // ★ THE BACKGROUND ALONE. The machine is busy, so the screensaver never
  // takes the stage and the background keeps it.
  const run = runSandbox({
    background: true,
    idle: () => ({ ok: true, idleMs: 10, status: 'ok', reason: 'ok' }),
  })
  await settle()
  run.clock.advance(1200)
  await settle()
  const before = run.controller.state()
  record('#48 the background is on the stage before the screensaver takes it',
    before.slots.background.playing === true && before.slot === 'background',
    JSON.stringify({ slot: before.slot, background: before.slots.background.playing }))
}

{
  // ★ THE SCREENSAVER TAKES THE STAGE, AND THEN GIVES IT BACK.
  const run = runSandbox({ background: true })
  await settle()
  run.clock.advance(1200)
  await settle()
  await bringUp(run)
  const during = run.controller.state()
  record('#49 the screensaver takes the stage and the background is pushed off',
    during.slot === 'screensaver' && during.slots.background.playing === false,
    JSON.stringify({ slot: during.slot, background: during.slots.background.playing }))

  // ★ THE SCREENSAVER IS TURNED OFF ⇒ IT RELEASES ⇒ THE BACKGROUND COMES BACK.
  run.dom.routes.set('/appearance-media/slots', () => slotsPayload({ enabled: false, mediaId: null }))
  run.clock.advance(2000)
  await settle()
  const after = run.controller.state()
  record('#50 after the screensaver releases, the background comes back BY THE ARBITRATION POINT',
    after.slot === 'background' && after.slots.background.playing === true,
    JSON.stringify({ slot: after.slot, background: after.slots.background.playing }))
}

/* ====================================================================== */
/* 10 · the materialApplied gate                                            */
/* ====================================================================== */

{
  // ★ THE SCREENSAVER'S LAYER IS UP AND ITS MATERIAL WAS NEVER APPLIED —
  // the material library did not answer. A change event must NOT tear the
  // layer down: the stage being empty is not a loss of the stage.
  const run = runSandbox({ catalog: 'hang' })
  await settle()
  run.clock.advance(2000)
  await settle()
  const before = run.surface.state()
  record('#51 the layer is up while the material is still missing',
    before.layer === true && before.visible === true,
    JSON.stringify({ layer: before.layer, visible: before.visible }))

  // ★ THE CONFIGURATION MOVES ⇒ THE ARBITRATION POINT PUBLISHES A CHANGE.
  run.dom.routes.set('/appearance-media/slots', () => slotsPayload({ revision: 2 }))
  run.clock.advance(2000)
  await settle()
  const after = run.surface.state()
  record('#52 a screensaver that never went on stage is NOT torn down by an empty stage',
    after.layer === true && after.visible === true,
    JSON.stringify({ layer: after.layer, visible: after.visible }))
}

/* ====================================================================== */
/* 11 · the yielding                                                        */
/* ====================================================================== */

{
  const run = runSandbox({ background: true })
  await bringUp(run)
  run.clock.advance(2000)
  await settle()
  const onStage = run.controller.state()
  record('#53 the screensaver is on the stage before the other plugin arrives',
    onStage.slot === 'screensaver', JSON.stringify(onStage.slot))

  // ★ THE OTHER WALLPAPER PLUGIN TAKES THE STAGE.
  run.dom.body.setAttribute('data-we-wallpaper', 'on')
  await settle()
  const yielded = run.controller.state()
  const left = run.dom.leftovers()
  const facts = run.surface.state()
  record('#54 another wallpaper plugin on the stage: the screensaver yields, and the marker is only read',
    yielded.slot !== 'screensaver' && left.videos === 0 && left.layers === 0 && left.styles === 0
      && facts.yielded === true && run.dom.body.getAttribute('data-we-wallpaper') === 'on',
    JSON.stringify({ slot: yielded.slot, left, yielded: facts.yielded }))

  const ourDisplaces = run.spy.displace.filter((entry) => entry.slot === 'screensaver')
  const ourReleases = run.spy.release.filter((entry) => entry.slot === 'screensaver')
  record('#55 the yielding uses displace(), NEVER release()',
    ourDisplaces.length > 0 && ourReleases.length === 0,
    'displace=' + JSON.stringify(ourDisplaces) + ' release=' + JSON.stringify(ourReleases))

  record('#56 the yielding does NOT hand the stage over to anybody',
    yielded.slot !== 'background',
    'slot=' + String(yielded.slot))

  record('#57 the slot stays enabled — the user did not turn it off',
    yielded.slots.screensaver.enabled === true,
    JSON.stringify(yielded.slots.screensaver))
}

{
  // ★ THE COMEBACK IS THE ARBITRATION POINT'S, NOT THE SURFACE'S. This one
  // runs WITHOUT the background surface, so exactly ONE surface can call
  // `restore()` — and the surface never applies the material itself.
  const run = runSandbox()
  await bringUp(run)
  run.dom.body.setAttribute('data-we-wallpaper', 'on')
  await settle()
  const yields = run.controller.state()
  record('#58 the yielding leaves the stage free and the slot still enabled',
    yields.slot !== 'screensaver' && yields.slots.screensaver.enabled === true,
    JSON.stringify({ slot: yields.slot, enabled: yields.slots.screensaver.enabled }))

  const appliesBefore = run.spy.apply.length
  run.dom.body.removeAttribute('data-we-wallpaper')
  await settle()
  const appliesAfter = run.spy.apply.length
  const back = run.controller.state()
  record('#59 when the marker disappears the surface calls restore() and lets the arbitration point decide',
    run.spy.restore.length === 1 && back.slot === 'screensaver',
    'restore=' + String(run.spy.restore.length) + ' slot=' + String(back.slot))

  record('#60 the comeback is NOT the surface applying the material itself',
    appliesAfter === appliesBefore,
    'applies=' + String(appliesAfter - appliesBefore))
}

/* ====================================================================== */
/* 12 · the negative controls                                               */
/* ====================================================================== */

{
  // ★ EVERY GROUP ABOVE IS RUN AGAIN AGAINST A DELIBERATELY BROKEN COPY.
  //
  // Each control computes the ORIGINAL verdict and the MUTATED verdict with
  // the SAME probe, and asserts that they DIFFER. A control that only
  // asserted "the mutated thing looks broken" would pass even when the
  // mutation did nothing.
  const controls = []
  const READINGS = {
    enabled: true,
    dismissed: false,
    bootOnStage: false,
    hiddenMs: 0,
    turnRunning: false,
    idleStatus: 'ok',
    idleMs: 600000,
    thresholdMs: 30000,
    blurredMs: 0,
  }
  const readings = (patch) => ({ ...READINGS, ...patch })

  /**
   * Run one control: the original verdict against the mutated one.
   * @param label - what the control is for.
   * @param original - the verdict the unmutated source gives.
   * @param mutated - the verdict the mutated source gives.
   */
  function control(label, original, mutated) {
    controls.push([label, JSON.stringify(original) !== JSON.stringify(mutated)])
  }

  /**
   * Build one control, and survive an anchor that does not match.
   *
   * ★ `mutate()` THROWS WHEN ITS ANCHOR IS GONE, and that is the protection:
   * a mutation that silently did nothing would make a control look green for
   * a change that never happened. So a control whose anchor is missing is
   * recorded as NOT APPLIED — it turns the suite red and says why, instead of
   * taking the whole run down.
   *
   * @param label - what the control is for.
   * @param build - the control's body; it throws when the anchor is gone.
   */
  async function attempt(label, build) {
    try {
      await build()
    } catch (error) {
      controls.push([label + ' (the anchor is gone — this control could not be applied)', false])
    }
  }

  // ① the trigger's order.
  await attempt('the trigger order', async () => {
    const brokenOrder = mutate(SAVER_TEXT,
      "if (r.enabled !== true) return { show: false, blockedBy: 'disabled' }",
      "if (r.enabled !== true && r.idleStatus !== 'ok') return { show: false, blockedBy: 'disabled' }",
      'the trigger order')
    const run1 = runSandbox({ sources: { screensaver: brokenOrder } })
    control('the trigger order',
      runSandbox().surface.decide(readings({ enabled: false })),
      run1.surface.decide(readings({ enabled: false })))
  })

  // ② the three states.
  await attempt('the three-state discipline', async () => {
    const brokenStates = mutate(SAVER_TEXT,
      "if (r.idleStatus === 'ok') {",
      "if (r.idleStatus !== 'unavailable') {",
      'the three-state discipline')
    const run2 = runSandbox({ sources: { screensaver: brokenStates } })
    control('the three-state discipline',
      runSandbox().surface.decide(readings({ idleStatus: 'starting' })),
      run2.surface.decide(readings({ idleStatus: 'starting' })))
  })

  // ③ the grace period.
  await attempt('the hidden grace period', async () => {
    const brokenGrace = mutate(SAVER_TEXT, 'var HIDDEN_GRACE_MS = 5000', 'var HIDDEN_GRACE_MS = 0', 'the grace period')
    const run3 = runSandbox({ sources: { screensaver: brokenGrace } })
    control('the hidden grace period',
      runSandbox().surface.decide(readings({ hiddenMs: 4999 })),
      run3.surface.decide(readings({ hiddenMs: 4999 })))
  })

  // ④ the dismissal latch.
  await attempt('the dismissal latch', async () => {
    const brokenLatch = mutate(SAVER_TEXT,
      'dismissedUntilActive = true\n    activitySinceDismiss = false',
      'dismissedUntilActive = false\n    activitySinceDismiss = false',
      'the dismissal latch')
    const run4 = runSandbox({ sources: { screensaver: brokenLatch } })
    await bringUp(run4)
    run4.surface.release()
    run4.clock.advance(600)
    await settle()
    const original4 = runSandbox()
    await bringUp(original4)
    original4.surface.release()
    original4.clock.advance(600)
    await settle()
    control('the dismissal latch',
      { dismissed: original4.surface.state().dismissed },
      { dismissed: run4.surface.state().dismissed })
  })

  // ⑤ the boot clip on the stage.
  await attempt('the boot-on-stage rule', async () => {
    const brokenBoot = mutate(SAVER_TEXT,
      "if (r.bootOnStage === true) return { show: false, blockedBy: 'boot-on-stage' }",
      "if (r.bootOnStage === true && r.hiddenMs > 0) return { show: false, blockedBy: 'boot-on-stage' }",
      'the boot-on-stage rule')
    const run5 = runSandbox({ sources: { screensaver: brokenBoot } })
    control('the boot-on-stage rule',
      runSandbox().surface.decide(readings({ bootOnStage: true })),
      run5.surface.decide(readings({ bootOnStage: true })))
  })

  // ⑥ the loop flag — this one lives in the arbitration point.
  await attempt('the loop flag', async () => {
    const brokenLoop = mutate(CONTROLLER_TEXT,
      'var LOOP_BY_SLOT = { background: true, boot: false, screensaver: true }',
      'var LOOP_BY_SLOT = { background: true, boot: false, screensaver: false }',
      'the loop flag')
    const run6 = runSandbox({ sources: { controller: brokenLoop } })
    await bringUp(run6)
    const media6 = run6.dom.body.children[0]?.children?.[0]?.children?.find((child) => child.tagName === 'VIDEO')
    const original6 = runSandbox()
    await bringUp(original6)
    const media6Original = original6.dom.body.children[0]?.children?.[0]?.children?.find((child) => child.tagName === 'VIDEO')
    control('the loop flag', { loop: media6Original?.loop }, { loop: media6?.loop })
  })

  // ⑦ the release order.
  await attempt('the release order', async () => {
    const brokenRelease = mutate(SAVER_TEXT,
      "      if (full === true) {\n        if (observer !== null) {",
      "      if (false) {\n        if (observer !== null) {",
      'the release order')
    const run7 = runSandbox({ sources: { screensaver: brokenRelease } })
    await bringUp(run7)
    const callsBefore = run7.clock.calls.length
    run7.surface.dispose()
    await settle()
    const order7 = releaseOrder(run7.clock.calls.slice(callsBefore))
    const original7 = runSandbox()
    await bringUp(original7)
    const callsBefore7 = original7.clock.calls.length
    original7.surface.dispose()
    await settle()
    const order7Original = releaseOrder(original7.clock.calls.slice(callsBefore7))
    control('the release order',
      { disconnect: order7Original.disconnect },
      { disconnect: order7.disconnect })
  })

  // ⑧ the probe's failure.
  await attempt('the probe failure', async () => {
    const brokenProbeText = mutate(readFileSync(
      fileURLToPath(new URL('../lib/probe.js', import.meta.url)), 'utf8'),
      "if (currentPlatform !== 'darwin') return failure(STATUS_UNAVAILABLE, 'not-darwin')",
      "if (currentPlatform !== 'darwin') return { ok: false, idleMs: 0, status: STATUS_UNAVAILABLE, reason: 'not-darwin' }",
      'the probe failure')
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-probe-'))
    const scratchPath = join(scratch, 'probe.mjs')
    writeFileSync(scratchPath, brokenProbeText, 'utf8')
    const brokenProbeModule = await import(pathToFileURL(scratchPath).href)
    const brokenAnswer = await brokenProbeModule.createProbe({ platform: 'linux' }).read()
    rmSync(scratch, { recursive: true, force: true })
    const originalAnswer = await createProbe({ platform: 'linux' }).read()
    control('the probe failure', { idleMs: originalAnswer.idleMs }, { idleMs: brokenAnswer.idleMs })
  })

  // ⑨ the host ownership.
  await attempt('the host ownership', async () => {
    const brokenHost = mutate(SAVER_TEXT,
      '      ensure: function () {\n        if (ensureStyle() === null) return null\n        if (ensureLayer() === null) return null\n        return true\n      },',
      '      ensure: function () {\n        return true\n      },',
      'the host ownership')
    const run9 = runSandbox({ sources: { screensaver: brokenHost }, noBody: true })
    await settle()
    const mutatedResult = run9.controller.apply('screensaver', entry('up-saver', 'saver-1.mp4'))
    const original9 = runSandbox({ noBody: true })
    await settle()
    const originalResult = original9.controller.apply('screensaver', entry('up-saver', 'saver-1.mp4'))
    control('the host ownership', { result: originalResult }, { result: mutatedResult })
  })

  // ⑩ the hand-over.
  await attempt('the hand-over', async () => {
    const brokenHandover = mutate(CONTROLLER_TEXT,
      '    releaseCurrent()\n    emitChange({ changed: [slot] })\n    restoreDisplaced()',
      '    releaseCurrent()\n    emitChange({ changed: [slot] })',
      'the hand-over')
    const run10 = runSandbox({ sources: { controller: brokenHandover }, background: true })
    await settle()
    run10.clock.advance(1200)
    await settle()
    await bringUp(run10)
    run10.dom.routes.set('/appearance-media/slots', () => slotsPayload({ enabled: false, mediaId: null }))
    run10.clock.advance(2000)
    await settle()
    const mutated10 = run10.controller.state().slot
    const original10 = runSandbox({ background: true })
    await settle()
    original10.clock.advance(1200)
    await settle()
    await bringUp(original10)
    original10.dom.routes.set('/appearance-media/slots', () => slotsPayload({ enabled: false, mediaId: null }))
    original10.clock.advance(2000)
    await settle()
    control('the hand-over', { slot: original10.controller.state().slot }, { slot: mutated10 })
  })

  // ⑪ the materialApplied gate.
  await attempt('the materialApplied gate', async () => {
    const brokenGate = mutate(SAVER_TEXT,
      '    if (materialApplied === true && stage !== SLOT\n      && (layerElement !== null || mediaElement !== null)) {',
      '    if (stage !== SLOT\n      && (layerElement !== null || mediaElement !== null)) {',
      'the materialApplied gate')
    const run11 = runSandbox({ sources: { screensaver: brokenGate }, catalog: 'hang' })
    await settle()
    run11.clock.advance(2000)
    await settle()
    run11.dom.routes.set('/appearance-media/slots', () => slotsPayload({ revision: 2 }))
    run11.clock.advance(2000)
    await settle()
    const original11 = runSandbox({ catalog: 'hang' })
    await settle()
    original11.clock.advance(2000)
    await settle()
    original11.dom.routes.set('/appearance-media/slots', () => slotsPayload({ revision: 2 }))
    original11.clock.advance(2000)
    await settle()
    control('the materialApplied gate',
      { layer: original11.surface.state().layer },
      { layer: run11.surface.state().layer })
  })

  // ⑫ the yielding.
  await attempt('the yielding', async () => {
    const brokenYield = mutate(SAVER_TEXT,
      "    if (displaced === true && typeof controller.displace === 'function') {",
      "    if (false && displaced === true && typeof controller.displace === 'function') {",
      'the yielding')
    const run12 = runSandbox({ sources: { screensaver: brokenYield }, background: true })
    await settle()
    run12.clock.advance(1200)
    await settle()
    await bringUp(run12)
    run12.dom.body.setAttribute('data-we-wallpaper', 'on')
    await settle()
    const original12 = runSandbox({ background: true })
    await settle()
    original12.clock.advance(1200)
    await settle()
    await bringUp(original12)
    original12.dom.body.setAttribute('data-we-wallpaper', 'on')
    await settle()
    control('the yielding',
      { displace: original12.spy.displace.filter((entry) => entry.slot === 'screensaver').length },
      { displace: run12.spy.displace.filter((entry) => entry.slot === 'screensaver').length })
  })

  for (const [label, flipped] of controls) {
    record('#61 NEGATIVE CONTROL — breaking ' + label + ' changes the verdict', flipped === true,
      'changed=' + String(flipped))
  }
  notes.push('the negative controls run against COPIES of the source; the files on disk are not touched')
}

/* ====================================================================== */
/*  12 · the styles: which break effect, which pointer effect             */
/* ====================================================================== */

{
  // ★ THE STYLE REACHES THE EFFECT.
  //
  // The setting is stored, the effect is chosen from it, and the state
  // reports which one was played. A setting that is saved and then ignored
  // cannot pass this, and neither can one that is saved and played as
  // something else.
  const played = []
  for (const style of ['particles', 'fall', 'glitch']) {
    const run = runSandbox({ slotsOptions: { breakEffect: true, breakStyle: style } })
    await bringUp(run)
    run.surface.release()
    run.clock.advance(600)
    await settle()
    played.push(style + '→' + String(run.surface.state().breakStyle))
  }
  record('#74 every break style reaches the effect, and the state reports which one played',
    played.length === 3
    && played[0] === 'particles→particles'
    && played[1] === 'fall→fall'
    && played[2] === 'glitch→glitch',
    played.join(' '))
}

{
  // ★ AN UNKNOWN STYLE IS NOT A GUESS. It falls back to the first effect
  // instead of quietly playing some other one.
  const run = runSandbox({ slotsOptions: { breakEffect: true, breakStyle: 'nonsense' } })
  await bringUp(run)
  run.surface.release()
  run.clock.advance(600)
  await settle()
  const played = run.surface.state().breakStyle
  record('#75 an unknown break style falls back to particles',
    played === 'particles', 'breakStyle=' + String(played))
}

{
  // ★ AND NOTHING IS PLAYED WHEN THE SWITCH IS OFF.
  const run = runSandbox({ slotsOptions: { breakEffect: false, breakStyle: 'fall' } })
  await bringUp(run)
  run.surface.release()
  run.clock.advance(600)
  await settle()
  const played = run.surface.state().breakStyle
  record('#76 no break effect is played while the switch is off',
    played === null, 'breakStyle=' + String(played))
}

{
  // ★ THE POINTER STYLE IS HONOURED, AND THE DEFAULT IS THE FIRST ONE.
  const seen = []
  for (const style of [undefined, 'ripples', 'attract', 'nonsense']) {
    const run = runSandbox({ slotsOptions: { pointerEffect: true, pointerStyle: style } })
    await bringUp(run)
    seen.push(String(style) + '→' + String(run.surface.state().pointerStyle))
  }
  record('#77 the pointer style is honoured, and an unknown one falls back to ripples',
    seen[0] === 'undefined→ripples'
    && seen[1] === 'ripples→ripples'
    && seen[2] === 'attract→attract'
    && seen[3] === 'nonsense→ripples',
    seen.join(' '))
}

{
  // ★ AND THE POINTER EFFECT IS NOT MOUNTED WHILE ITS SWITCH IS OFF.
  const run = runSandbox({ slotsOptions: { pointerEffect: false, pointerStyle: 'attract' } })
  await bringUp(run)
  const facts = run.surface.state()
  record('#78 the pointer art is not mounted while the pointer switch is off',
    facts.pointerArtMounted === false && facts.pointerStyle === null,
    JSON.stringify({ mounted: facts.pointerArtMounted, style: facts.pointerStyle }))
}

/* ---------------------------------------------------------------- report */

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed += 1
  const mark = ok ? 'PASS ' : 'FAIL '
  console.log(mark + ' ' + label + (detail === '' ? '' : '  — ' + detail))
}
for (const note of notes) {
  console.log('NOTE  ' + note)
}
console.log(String(checks.length) + ' check(s), ' + String(failed) + ' failed')
process.exit(failed === 0 ? 0 : 1)
