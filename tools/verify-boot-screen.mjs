#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the boot screen surface.
//
// What it proves, and what it deliberately does not:
//
//   * it EVALUATES THE REAL SOURCE TEXT of `src/boot-screen.js` — the very
//     bytes the Host pushes into the page — next to the real adapters and the
//     real arbitration point, inside a `node:vm` context with a fake DOM, a
//     fake Host route and a FAKE CLOCK;
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
// THE ORDER, THE BOUND AND THE HAND-OVER ASSERTIONS HAVE A NEGATIVE CONTROL.
//
// A check that has never failed is not a check. So the important assertions
// are run a second time against a deliberately broken copy of the source, and
// the broken copy MUST produce a different verdict.
//
// The holes this suite is written against:
//
//   * the boot clip must NOT loop — a looping element never fires `ended`, so
//     a looping boot clip holds the viewport forever;
//   * a material whose length cannot be known must still have an upper bound;
//   * the material library is fetched with a bounded wait;
//   * all THREE hand-over paths (the clip ended, the upper bound, the kernel
//     is ready with nothing to show) must remove the screen, and none of them
//     may leave one of our elements behind;
//   * the release order — pause, clear the source, unbind, disconnect, clear
//     the timers, remove the elements — item by item;
//   * the configuration is read live and never baked into the injected text;
//   * the arbitration point must mount the material in the boot surface's own
//     stage, and must fail loudly instead of falling back to the body;
//   * after the hand-over the background comes back — by the arbitration
//     point, not by the surfaces talking to each other.
//
// Usage: node tools/verify-boot-screen.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BOOT_PATH = fileURLToPath(new URL('../src/boot-screen.js', import.meta.url))
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

/** The boot surface's source text. */
const BOOT_TEXT = readFileSync(BOOT_PATH, 'utf8')
/** The boot surface's source text, comments stripped. */
const BOOT_CODE = stripComments(BOOT_TEXT)
/** The adapters' source text. */
const RENDERERS_TEXT = readFileSync(RENDERERS_PATH, 'utf8')
/** The arbitration point's source text. */
const CONTROLLER_TEXT = readFileSync(CONTROLLER_PATH, 'utf8')

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
    ['a negative z-index', /z-index\s*:\s*-\s*\d/],
  ]
  const found = []
  for (const [label, pattern] of shapes) {
    if (pattern.test(text)) found.push(label)
  }
  return found
}

/**
 * Whether one element is inside another one.
 *
 * The ancestry is walked, not guessed: the media is mounted into the STAGE,
 * and the stage is inside the LAYER — a check that looked for the media as a
 * direct child of the layer would never match.
 *
 * @param root - the ancestor.
 * @param node - the node to look for.
 * @returns true when the node is inside the root.
 */
function isInside(root, node) {
  let current = node
  while (current !== undefined && current !== null) {
    if (current === root) return true
    current = current.parentNode
  }
  return false
}

/**
 * Replace one snippet of a source text.
 *
 * The replacement MUST happen: a reverse control whose mutation does not
 * apply would silently prove nothing.
 *
 * @param text - the source text.
 * @param from - the snippet to replace.
 * @param to - the replacement.
 * @param what - the name of the mutation, for the error message.
 * @returns the mutated text.
 */
function mutate(text, from, to, what) {
  if (!text.includes(from)) {
    throw new Error('the reverse control "' + what + '" does not match the source any more')
  }
  return text.replace(from, to)
}

/* ----------------------------------------------------------------- clock */

/**
 * Build a fake clock: timers that only fire when the test says so.
 *
 * ★ A REAL TIMER WOULD MAKE THE SUITE A SLEEPING SUITE. The bounds this
 * suite asserts are twenty seconds long, and a suite that waits for them is a
 * suite nobody runs.
 *
 * @returns the clock.
 */
function createClock(act) {
  const note = typeof act === 'function' ? act : () => {}
  let now = 0
  let seq = 0
  /** @type {Map<number, {id:number, at:number, fn:Function, every:number|null}>} */
  const timers = new Map()

  /**
   * Arm one timer.
   * @param fn - the callback.
   * @param ms - the delay.
   * @param every - the period, for an interval; null for a timeout.
   * @returns the timer id.
   */
  function arm(fn, ms, every) {
    const id = ++seq
    timers.set(id, { id, at: now + (typeof ms === 'number' && isFinite(ms) ? ms : 0), fn, every })
    return id
  }

  /**
   * Cancel one timer.
   * @param id - the timer id.
   */
  function cancel(id) {
    timers.delete(id)
  }

  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      note('setTimeout')
      return arm(fn, ms, null)
    },
    // ★ CLEARING A TIMER AND CLEARING AN INTERVAL ARE DIFFERENT CALLS, AND
    // THE RELEASE ORDER READS THEM APART.
    clearTimeout: (id) => {
      note('clearTimeout')
      cancel(id)
    },
    setInterval: (fn, ms) => {
      note('setInterval')
      return arm(fn, ms, typeof ms === 'number' && isFinite(ms) ? ms : 1000)
    },
    clearInterval: (id) => {
      note('clearInterval')
      cancel(id)
    },
    /** The number of live timers. */
    count: () => timers.size,
    /**
     * Move the clock forward, firing whatever comes due.
     * @param ms - how far to move.
     * @returns a promise that resolves when the work has drained.
     */
    async advance(ms) {
      const target = now + (typeof ms === 'number' && isFinite(ms) ? ms : 0)
      for (;;) {
        let next = null
        for (const timer of timers.values()) {
          if (timer.at > target) continue
          if (next === null || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
            next = timer
          }
        }
        if (next === null) break
        now = next.at
        if (next.every === null) timers.delete(next.id)
        else next.at = now + next.every
        try {
          next.fn()
        } catch (error) {
          /* a timer that throws must not stop the clock */
        }
        await tick()
      }
      now = target
      await tick()
    },
  }
}

/* -------------------------------------------------------------- fake DOM */

/**
 * Build a fake DOM: elements that remember what was done to them.
 *
 * Two logs are kept apart on purpose:
 *
 *   * `calls` — the MUTATING actions, in order. This is the log the release
 *     order is read from.
 *   * `reads` — the reads. They must not appear in the order log, or a read
 *     in the middle of the release would break "the source is cleared right
 *     after the pause".
 *
 * @param options - `wallpaper`: the other plugin's marker on the body.
 * @returns the fake DOM.
 */
function createFakeDom(options = {}) {
  /** The mutating actions, in order. */
  const calls = []
  /** The reads, in order. */
  const reads = []
  /** Every element that was created. */
  const elements = []

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
   * Collect the elements that match a selector.
   * @param root - the root element.
   * @param selector - 'video' or 'img'.
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
      paused: true,
      ended: false,
      readyState: 0,
      currentTime: 0,
      // ★ THE LENGTH IS UNKNOWN BY DEFAULT. A MediaRecorder WebM reports
      // `Infinity` and a still picture has no duration at all, and both are the
      // case the upper bound exists for.
      duration: Number.NaN,
      complete: false,
      naturalWidth: 0,
      error: null,
      setAttribute(name, value) {
        act('setAttribute:' + name)
        element.attributes[name] = String(value)
      },
      removeAttribute(name) {
        act('removeAttribute:' + name)
        delete element.attributes[name]
        // ★ THE SOURCE PROPERTY REALLY GOES. A fake that only forgets the
        // attribute would hide "the source was cleared" behind a green
        // assertion.
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
      dispatch(type) {
        const list = (listeners[type] === undefined ? [] : listeners[type]).slice()
        for (const fn of list) fn({ type })
      },
      play() {
        act('play')
        element.paused = false
        return Promise.resolve()
      },
      pause() {
        act('pause')
        element.paused = true
      },
      load() {
        act('load')
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
    parentNode: null,
    children: [],
    appendChild(child) {
      act('body.appendChild:' + child.tagName)
      body.children.push(child)
      child.parentNode = body
      return child
    },
    removeChild(child) {
      act('body.removeChild:' + child.tagName)
      detach(child)
      return child
    },
    getAttribute(name) {
      look('body.getAttribute:' + name)
      return body.attributes[name]
    },
    hasAttribute(name) {
      look('body.hasAttribute:' + name)
      return Object.prototype.hasOwnProperty.call(body.attributes, name)
    },
    setAttribute(name, value) {
      act('body.setAttribute:' + name)
      body.attributes[name] = String(value)
      notifyObservers()
    },
    removeAttribute(name) {
      act('body.removeAttribute:' + name)
      delete body.attributes[name]
      notifyObservers()
    },
    querySelectorAll(selector) {
      look('body.querySelectorAll:' + selector)
      return collect(body, selector)
    },
  }
  if (options.wallpaper !== undefined) body.attributes['data-we-wallpaper'] = options.wallpaper

  /**
   * The head. The style element lives there.
   */
  const head = {
    tagName: 'HEAD',
    children: [],
    parentNode: null,
    appendChild(child) {
      act('head.appendChild:' + child.tagName)
      head.children.push(child)
      child.parentNode = head
      return child
    },
    removeChild(child) {
      act('head.removeChild:' + child.tagName)
      detach(child)
      return child
    },
  }

  /**
   * The document.
   */
  const document = {
    visibilityState: 'visible',
    hidden: false,
    body,
    head,
    documentElement: head,
    listeners: {},
    createElement(tag) {
      return createElement(tag)
    },
    addEventListener(type, fn) {
      act('document.addEventListener:' + type)
      if (document.listeners[type] === undefined) document.listeners[type] = []
      document.listeners[type].push(fn)
    },
    removeEventListener(type, fn) {
      act('document.removeEventListener:' + type)
      const list = document.listeners[type] === undefined ? [] : document.listeners[type]
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatch(type) {
      const list = (document.listeners[type] === undefined ? [] : document.listeners[type]).slice()
      for (const fn of list) fn({ type })
    },
    querySelectorAll(selector) {
      look('document.querySelectorAll:' + selector)
      return collect(body, selector)
    },
  }

  /**
   * The observers that watch the body.
   *
   * ★ A REAL MutationObserver FIRES WHEN THE ATTRIBUTE CHANGES. The fake has
   * to do the same, or the yielding path is never exercised.
   */
  const observers = []

  /**
   * Tell every observer that the body changed.
   */
  function notifyObservers() {
    for (const observer of observers.slice()) {
      if (typeof observer.callback === 'function') observer.callback([], observer)
    }
  }

  /**
   * The observer. The surface watches the body for the other plugin's marker.
   */
  class FakeMutationObserver {
    /**
     * @param callback - the callback.
     */
    constructor(callback) {
      this.callback = callback
      this.observed = null
      this.options = null
      observers.push(this)
    }

    /**
     * @param target - the observed node.
     * @param observeOptions - the options.
     */
    observe(target, observeOptions) {
      act('observe')
      this.observed = target
      this.options = observeOptions
    }

    /** Detach the observer. */
    disconnect() {
      act('disconnect')
      this.observed = null
    }

    /** Pretend the body changed. */
    trigger() {
      if (typeof this.callback === 'function') this.callback([], this)
    }
  }

  return { calls, reads, elements, observers, body, head, document, createElement, act, look, MutationObserver: FakeMutationObserver }
}

/* ----------------------------------------------------------- the payloads */

/**
 * Build the answer of the slot route.
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
      revision: options.revision ?? 1,
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
 * Build the answer of the material library.
 * @param entries - the entries.
 * @returns the answer.
 */
function catalogPayload(entries) {
  return { ok: true, revision: 1, entries }
}

/**
 * A library entry, the way the library route publishes it.
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
 * The key the surface remembers its recent picks under.
 *
 * ★ IT IS WRITTEN HERE ON PURPOSE. The rotation history is the surface's own
 * memory of what it played last, and it is also what makes a pool pick
 * deterministic — a scenario that seeds the history has to seed the key the
 * surface reads.
 */
const RECENT_KEY = 'dsh-appearance-media:boot:recent'

/**
 * A `Math` whose `random` always answers the same number.
 *
 * ★ THE PICK IS RANDOM, AND A RANDOM PICK CANNOT PROVE A RULE. The same run
 * could pick the material the assertion wants or the one it forbids, and a
 * check that flips with the dice is not a check. A fixed `random` turns the
 * pick into a function of the candidate list — and the candidate list is
 * exactly what the pool assertions are about.
 *
 * @param value - the number `Math.random` answers.
 * @returns the Math to put in the sandbox.
 */
function seededMath(value) {
  const seeded = Object.create(Math)
  seeded.random = () => value
  return seeded
}

/**
 * A fake sessionStorage, shared by every sandbox in this suite.
 *
 * ★ A REAL ONE IS SHARED BY EVERY PAGE OF THE SESSION. A per-sandbox store
 * would make the rotation history look like it never worked.
 */
const sessionStore = new Map()
/** How many times the session storage was written. */
let sessionWrites = 0
const fakeSessionStorage = {
  getItem(key) { return sessionStore.has(String(key)) ? sessionStore.get(String(key)) : null },
  setItem(key, value) { sessionWrites += 1; sessionStore.set(String(key), String(value)) },
  removeItem(key) { sessionStore.delete(String(key)) },
  clear() { sessionStore.clear() },
}

/* ----------------------------------------------------------- the sandbox */

/**
 * Run the three scripts in a fresh context.
 *
 * @param options - `boot`, `renderers`, `controller`, `payload`, `catalog`,
 *   `wallpaper`, `catalogHangs`, `withController`, `random`.
 * @returns the sandbox and the fake DOM.
 */
function runSandbox(options = {}) {
  const dom = createFakeDom({ wallpaper: options.wallpaper })
  const clock = createClock(dom.act)
  const bootText = options.boot === undefined ? BOOT_TEXT : options.boot
  const renderersText = options.renderers === undefined ? RENDERERS_TEXT : options.renderers
  const controllerText = options.controller === undefined ? CONTROLLER_TEXT : options.controller
  const fetchLog = []
  const warnings = []
  let payload = options.payload === undefined ? slotsPayload() : options.payload
  let catalog = options.catalog === undefined ? catalogPayload([entry('up-boot')]) : options.catalog
  const catalogHangs = options.catalogHangs === true

  let resolveGate = null
  let rejectGate = null
  const gate = {
    // ★ THE DEFERRED CAN FAIL AS WELL AS SUCCEED. The Host's readiness
    // deferred has a reject path, and the boot screen has to be able to see
    // it — a sandbox that can only resolve can never prove what happens
    // when the application does not come up.
    promise: new Promise((resolve, reject) => { resolveGate = resolve; rejectGate = reject }),
    resolve: () => {},
    reject: () => {},
  }

  const sandbox = {
    console: {
      log() {},
      warn(...args) { warnings.push(args.map((arg) => String(arg)).join(' ')) },
      error() {},
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    fetch(url, init) {
      fetchLog.push({ url, init })
      // ★ A LIBRARY THAT NEVER ANSWERS. The bounded wait is what the screen
      // has to survive.
      if (catalogHangs === true && String(url).includes('catalog.json')) {
        return new Promise(() => {})
      }
      const body = String(url).includes('catalog.json') ? catalog : payload
      return Promise.resolve({
        ok: true,
        status: 200,
        json() { return Promise.resolve(body) },
      })
    },
    MutationObserver: dom.MutationObserver,
    document: dom.document,
    // ★ A HOST THAT NEVER CREATES THE SIGNAL. The readiness deferred is
    // created by a script at the end of the body; a Host that fails before
    // it gets there never creates it, and the surface must not wait forever
    // for something that does not exist.
    ...(options.noGate === true ? {} : { __DSH_BOOT_READY__: gate }),
    // ★ A FAKE sessionStorage, SHARED BY EVERY SANDBOX.
    //
    // The pool's rotation history lives in sessionStorage, and without this
    // the whole history path is dead in the suite: every sandbox would start
    // with an empty history and the same clip would be allowed twice in a
    // row. The store is shared because a real sessionStorage IS shared by
    // every page of the session.
    sessionStorage: fakeSessionStorage,
    // ★ A FIXED `Math.random`, WHEN THE SCENARIO ASKS FOR ONE.
    //
    // The pool pick is random, and a random pick cannot prove a rule: the
    // same scenario could pick the material the assertion allows or the one
    // it forbids, and a check that flips with the dice is not a check. A
    // fixed `random` makes the pick a function of the candidate list.
    ...(options.random === undefined ? {} : { Math: seededMath(options.random) }),
  }

  vm.createContext(sandbox)
  if (renderersText !== null) vm.runInContext(renderersText, sandbox, { filename: 'renderers.js' })
  if (controllerText !== null && options.withController !== false) {
    vm.runInContext(controllerText, sandbox, { filename: 'controller.js' })
  }
  if (bootText !== null) vm.runInContext(bootText, sandbox, { filename: 'boot-screen.js' })

  return {
    sandbox,
    dom,
    clock,
    fetchLog,
    warnings,
    controller: sandbox.__DSH_APPEARANCE_CONTROLLER__,
    boot: sandbox.__DSH_APPEARANCE_BOOT__,
    renderers: sandbox.__DSH_APPEARANCE_RENDERERS__,
    setPayload(next) { payload = next },
    setCatalog(next) { catalog = next },
    /** Forget the session's rotation history. */
    resetSession() { sessionStore.clear(); sessionWrites = 0 },
    /** How many times the session storage was written. */
    sessionWrites() { return sessionWrites },
    /** The kernel reports itself ready. */
    kernelReady() { resolveGate() },
    /** The kernel reports that it will not come up. */
    kernelFailed() { rejectGate(new Error('the kernel did not come up')) },
    /** The videos that are on the page right now. */
    videos() { return dom.document.querySelectorAll('video') },
    /** The boot overlays that are on the page right now. */
    layers() { return dom.body.children.filter((child) => child.className === 'dsham-boot-layer') },
    /** The style elements that are on the page right now. */
    styles() { return dom.head.children.filter((child) => child.tagName === 'STYLE') },
    /** What is left of us. */
    leftovers() {
      return {
        layers: dom.body.children.filter((child) => child.className === 'dsham-boot-layer').length,
        styles: dom.head.children.filter((child) => child.tagName === 'STYLE').length,
        videos: dom.document.querySelectorAll('video').length,
      }
    },
  }
}

/**
 * Let the material paint a frame.
 *
 * ★ WITHOUT A FRAME THE WATCHDOG FIRES, AND THE SCREEN LEAVES FOR THE WRONG
 * REASON. A suite that never paints one would prove the watchdog and call it
 * the hand-over.
 *
 * @param run - the sandbox.
 * @returns true when a frame was painted.
 */
function paintFrame(run) {
  const video = run.videos()[0]
  if (video === undefined) return false
  video.readyState = 4
  video.dispatch('loadeddata')
  return true
}

/**
 * The boot payload: the boot slot is on and points at a material.
 * @param mediaId - the media id.
 * @param options - `options` for the boot group.
 * @returns the answer.
 */
function bootPayload(mediaId = 'up-boot', options = {}) {
  return slotsPayload({
    slots: { boot: { enabled: true, mediaId, revision: 3 } },
    options: { boot: options },
  })
}

/* --------------------------------------------------- the release order */

/**
 * Read the release order out of the action log.
 *
 * ★ THE ORDER IS READ ITEM BY ITEM, NOT "SOME OF IT HAPPENED".
 *
 * Every step is located by its own marker, and the steps are compared with
 * each other. "Clear the source" must be the action IMMEDIATELY after the
 * pause — the browser keeps downloading and decoding a media element whose
 * source is still attached.
 *
 * @param calls - the action log.
 * @returns the verdict and the evidence.
 */
function releaseOrder(calls) {
  const at = (name) => calls.findIndex((call) => call === name || call.startsWith(name + ':'))
  const pause = at('pause')
  const clearSource = at('removeAttribute:src')
  const unbind = calls.findIndex((call) => call.startsWith('removeEventListener:'))
  const unbindOwn = calls.findIndex((call) => call.includes('removeEventListener:keydown'))
  const disconnect = at('disconnect')
  const clearTimer = at('clearInterval')
  const removals = []
  for (let i = 0; i < calls.length; i += 1) {
    if (calls[i].startsWith('remove:') || calls[i].startsWith('removeChild:')) removals.push(i)
  }
  const removeFirst = removals.length > 0 ? removals[0] : -1
  const removeLast = removals.length > 0 ? removals[removals.length - 1] : -1
  const ok = pause >= 0
    && clearSource === pause + 1
    && unbind > clearSource
    && unbindOwn > unbind
    && disconnect > unbindOwn
    && clearTimer > disconnect
    && removeFirst > clearTimer
    && removeLast > removeFirst
  return {
    ok,
    detail: 'pause=' + String(pause) + ' clearSrc=' + String(clearSource)
      + ' unbind=' + String(unbind) + ' unbindOwn=' + String(unbindOwn)
      + ' disconnect=' + String(disconnect) + ' clearTimer=' + String(clearTimer)
      + ' removeFirst=' + String(removeFirst) + ' removeLast=' + String(removeLast),
  }
}

/* ------------------------------------------------------------------ run */

let exitCode = 0

try {
  /* ---- the static shape of the surface ------------------------------ */

  {
    const found = forbiddenShapes(BOOT_CODE)
    record('#1 the boot source is plain script text with no forbidden shape',
      found.length === 0, JSON.stringify(found))
  }

  {
    const published = BOOT_TEXT.includes('globalThis.__DSH_APPEARANCE_BOOT__ =')
    const ownPoint = /__DSH_APPEARANCE_CONTROLLER__\s*=[^=]/.test(BOOT_TEXT)
    record('#2 the surface publishes its own global and creates no arbitration point',
      published && !ownPoint, 'published=' + String(published) + ' ownPoint=' + String(ownPoint))
  }

  {
    // ★ NO CONFIGURATION IS BAKED. The names of the options may appear — they
    // are the API — but no VALUE may: every number that is a budget has to be
    // a fallback, and the real one is read from the Host at runtime.
    const baked = /\b(?:holdMs|fadeMs|idleMs|enterMode)\s*[:=]\s*["']?\d/.test(BOOT_CODE)
    const snapshot = /__DSH_BOOT_ANIM_CFG__|__DSH_APPEARANCE_CFG__/.test(BOOT_CODE)
    record('#3 no configuration value is baked into the injected text',
      !baked && !snapshot, 'baked=' + String(baked) + ' snapshot=' + String(snapshot))
  }

  {
    const routes = ['/appearance-media/slots', '/appearance-media/catalog.json']
    const present = routes.every((route) => BOOT_TEXT.includes(route))
    record('#4 the surface reads the slot route and the material library',
      present, JSON.stringify(routes))
  }

  {
    const attribution = BOOT_TEXT.includes('Copyright (c) 2026 dsh-boot-animation contributors')
    record('#5 the ported code keeps its copyright notice', attribution,
      'attribution=' + String(attribution))
  }

  /* ---- the surface on a page ---------------------------------------- */

  {
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    const video = run.videos()[0]
    const layer = run.layers()[0]
    const inside = layer !== undefined && video !== undefined && isInside(layer, video)
    record('#6 the surface puts the configured material INSIDE its own overlay',
      run.boot !== undefined && run.boot !== null
      && run.boot.available === true
      && run.layers().length === 1
      && run.videos().length === 1
      && inside,
      'layers=' + String(run.layers().length) + ' videos=' + String(run.videos().length)
      + ' inside=' + String(inside) + ' mediaId=' + String(run.boot?.state?.().mediaId))
  }

  {
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    const video = run.videos()[0]
    const src = video === undefined ? '' : String(video.src)
    record('#7 the media URL comes from the library entry, never from a hand-written path',
      src === '/appearance-media/media/up-boot', 'src=' + src)
  }

  {
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    const video = run.videos()[0]
    const loop = video === undefined ? null : video.loop
    record('#8 the boot clip does NOT loop — a looping clip never fires `ended`',
      loop === false, 'loop=' + String(loop))
  }

  {
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    const urls = run.fetchLog.map((row) => row.url)
    const caches = run.fetchLog.map((row) => row.init?.cache)
    const readLive = urls.includes('/appearance-media/slots')
      && urls.includes('/appearance-media/catalog.json')
      && caches.every((cache) => cache === 'no-store')
    record('#9 the configuration and the library are read live, and never cached',
      readLive, 'urls=' + JSON.stringify(urls) + ' caches=' + JSON.stringify(caches))
  }

  {
    // ★ THE BOUNDED WAIT. The library never answers; the screen has to stop
    // waiting for it and let the kernel in.
    const run = runSandbox({ payload: bootPayload(), catalogHangs: true })
    await tick()
    await run.clock.advance(10)
    const loading = run.boot?.state?.().clip
    await run.clock.advance(11000)
    const gaveUp = run.boot?.state?.().clip
    record('#10 the material library is fetched with a bounded wait',
      loading === 'loading' && gaveUp === 'none',
      'whileLoading=' + String(loading) + ' afterTheWindow=' + String(gaveUp))
  }

  {
    // ★ THE HOLD BUDGET IS READ FROM THE CONFIGURATION, NOT BAKED.
    const run = runSandbox({ payload: bootPayload('up-boot', { holdMs: 3000 }) })
    await tick()
    await run.clock.advance(10)
    const before = run.boot?.state?.().holdMs
    await run.clock.advance(3500)
    const caption = run.dom.body.children
      .filter((child) => child.className === 'dsham-boot-layer')
      .flatMap((child) => child.children)
      .flatMap((child) => child.children ?? [])
      .find((child) => child.className === 'dsham-boot-caption')
    record('#11 the hold budget comes from the configuration the user just set',
      before === 3000 && caption !== undefined && String(caption.textContent).includes('启动较慢'),
      'holdMs=' + String(before) + ' caption=' + String(caption?.textContent))
  }

  /* ---- the three hand-over paths ------------------------------------- */

  {
    // ① THE MATERIAL ENDED.
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    // ★ THE APPLICATION IS UP BEFORE THE CLIP ENDS. The hand-over waits for
    // the kernel — the upstream plugin does the same, and the screen must
    // not be torn down over an empty shell.
    run.kernelReady()
    await tick()
    const video = run.videos()[0]
    video.dispatch('ended')
    await run.clock.advance(3000)
    const left = run.leftovers()
    record('#12 hand-over ①: the material ended — the screen removes itself',
      left.layers === 0 && left.styles === 0 && left.videos === 0,
      'left=' + JSON.stringify(left))
  }

  {
    // ② THE UPPER BOUND. A material whose length cannot be known.
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    // ★ THE APPLICATION IS UP. The upper bound hands the viewport over only
    // after the kernel is ready — the same gate as the end of the material.
    run.kernelReady()
    await tick()
    const video = run.videos()[0]
    video.duration = Number.POSITIVE_INFINITY
    // ★ THE HAND-OVER INCLUDES THE DISSOLVE. The bound fires at twenty
    // seconds and the overlay is gone a couple of seconds later.
    await run.clock.advance(24000)
    const left = run.leftovers()
    record('#13 hand-over ②: the upper bound expires — the screen removes itself',
      left.layers === 0 && left.styles === 0 && left.videos === 0,
      'left=' + JSON.stringify(left) + ' duration=' + String(video.duration))
  }

  {
    // ③ THE KERNEL IS READY AND THERE IS NOTHING TO SHOW.
    const run = runSandbox({ payload: slotsPayload() })
    await tick()
    await run.clock.advance(10)
    const before = run.leftovers()
    run.kernelReady()
    await tick()
    await run.clock.advance(3000)
    const left = run.leftovers()
    record('#14 hand-over ③: the kernel is ready and nothing is configured — the screen removes itself',
      before.layers === 1 && left.layers === 0 && left.styles === 0 && left.videos === 0,
      'before=' + JSON.stringify(before) + ' left=' + JSON.stringify(left))
  }

  {
    // ★ THE BOUND IS A BOUND: twenty seconds, not "whenever the clip ends".
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    // ★ THE APPLICATION IS UP, SO THE UPPER BOUND MAY HAND THE VIEWPORT
    // OVER. Without the kernel the screen holds — the same gate as every
    // other way out of it.
    run.kernelReady()
    await tick()
    const video = run.videos()[0]
    video.duration = Number.POSITIVE_INFINITY
    await run.clock.advance(19000)
    const stillThere = run.leftovers().layers
    await run.clock.advance(5000)
    const gone = run.leftovers().layers
    record('#15 the upper bound is twenty seconds — and it is really twenty seconds',
      stillThere === 1 && gone === 0, 'at19s=' + String(stillThere) + ' at24s=' + String(gone))
  }

  /* ---- the release order --------------------------------------------- */

  {
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.kernelReady()
    await tick()
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    const verdict = releaseOrder(run.dom.calls)
    record('#16 the release order is pause, clear the source, unbind, disconnect, clear the timer, remove',
      verdict.ok, verdict.detail)
  }

  /* ---- the host belongs to the surface ------------------------------- */

  {
    // ★ THE ARBITRATION POINT MUST MOUNT IN THE SURFACE'S OWN STAGE. If the
    // surface cannot give a host, the attempt FAILS — it never falls back to
    // the body, where a media element has no positioning and lands below the
    // viewport.
    const run = runSandbox({
      payload: bootPayload(),
      boot: mutate(BOOT_TEXT,
        '        if (ensureLayer() === null) return null\n        ensureObserver()\n        return true',
        '        if (ensureLayer() === null) return null\n        ensureObserver()\n        return null',
        'the surface cannot give a host'),
    })
    await tick()
    await run.clock.advance(10)
    const result = run.boot?.state?.().lastResult
    const onBody = run.dom.body.children.some((child) => child.tagName === 'VIDEO')
    record('#17 a surface that cannot give a host fails loudly — the material never lands on the body',
      result === 'failed-kept-previous' && onBody === false && run.videos().length === 0,
      'result=' + String(result) + ' onBody=' + String(onBody)
      + ' videos=' + String(run.videos().length))
  }

  {
    // ★ THE SAME ASSERTION, THE OTHER WAY ROUND: with a working host the
    // material lands inside the overlay and the answer is `applied`.
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    const result = run.boot?.state?.().lastResult
    const layer = run.layers()[0]
    const video = run.videos()[0]
    const inside = layer !== undefined && video !== undefined && isInside(layer, video)
    record('#18 with a host of its own the material is mounted and the answer is `applied`',
      result === 'applied' && inside && run.dom.body.children.length === 1,
      'result=' + String(result) + ' inside=' + String(inside)
      + ' bodyChildren=' + String(run.dom.body.children.length))
  }

  /* ---- the hand-over to the background -------------------------------- */

  {
    // ★ THE STAGE IS HANDED OVER BY THE ARBITRATION POINT, NOT BY THE
    // SURFACES TALKING TO EACH OTHER. A stand-in surface takes the background
    // slot; the boot clip pushes it off the stage; when the boot clip hands
    // over, the background comes back — and the boot surface never mentions
    // the background at all.
    const run = runSandbox({
      payload: slotsPayload({
        slots: {
          boot: { enabled: true, mediaId: 'up-boot', revision: 3 },
          background: { enabled: true, mediaId: 'up-bg', revision: 4 },
        },
      }),
      catalog: catalogPayload([entry('up-boot'), entry('up-bg')]),
    })
    const mounted = []
    run.controller.registerHost('background', {
      createElement(tag) { return run.dom.createElement(tag) },
      mount(element) { mounted.push(element) },
      unmount(element) { /* the stand-in does not own a layer */ },
      ensure() { return true },
      resolve() { return Promise.resolve(entry('up-bg')) },
    })
    // ★ THE BACKGROUND IS ON THE STAGE FIRST — before the boot surface has
    // had a chance to apply anything, so the boot clip really is the one that
    // pushes it off.
    run.controller.apply('background', entry('up-bg'))
    await tick()
    await run.clock.advance(10)
    const before = mounted.length
    // The boot clip takes the stage and pushes it off.
    run.kernelReady()
    await tick()
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    await tick()
    await tick()
    const after = mounted.length
    const mentionsBackground = BOOT_TEXT.includes('__DSH_APPEARANCE_BACKGROUND__')
      || BOOT_TEXT.includes('BACKGROUND')
    record('#19 after the hand-over the background comes back — by the arbitration point, not by the surfaces',
      before === 1 && after === 2 && mentionsBackground === false,
      'mountedBefore=' + String(before) + ' mountedAfter=' + String(after)
      + ' mentionsTheBackground=' + String(mentionsBackground))
  }

  /* ---- the enter mode and the material source --------------------------- */

  {
    // ★ 'click' NEVER ENTERS ON ITS OWN.
    //
    // Two things happen that would each have entered the screen in the
    // other modes: the clip ends, and the kernel reports itself ready.
    // Neither of them may enter while the mode says the user has to.
    const run = runSandbox({ payload: bootPayload('up-boot', { enterMode: 'click' }) })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    const video = run.videos()[0]
    video.dispatch('ended')
    await run.clock.advance(3000)
    run.kernelReady()
    await run.clock.advance(3000)
    const left = run.leftovers()
    record('#28 enterMode=click: the screen does NOT enter on its own — not when the clip ends, not when the kernel is ready',
      left.layers > 0,
      'left=' + JSON.stringify(left))
  }

  {
    // ★ AND THE OTHER TWO MODES DO ENTER WHEN THE CLIP ENDS.
    //
    // 'tail' dissolves over the clip's last fade, 'end' plays it out and
    // then fades. Both of them are gone a couple of seconds after the clip
    // ends.
    const verdicts = []
    for (const mode of ['tail', 'end']) {
      const run = runSandbox({ payload: bootPayload('up-boot', { enterMode: mode }) })
      await tick()
      await run.clock.advance(10)
      paintFrame(run)
      run.kernelReady()
      await tick()
      run.videos()[0].dispatch('ended')
      await run.clock.advance(3000)
      const left = run.leftovers()
      verdicts.push(mode + ':' + String(left.layers) + '/' + String(left.styles) + '/' + String(left.videos))
      if (left.layers !== 0 || left.styles !== 0 || left.videos !== 0) break
    }
    record('#29 enterMode=tail and enterMode=end both hand the screen over when the material ends',
      verdicts.length === 2 && verdicts.every((line) => line.endsWith('0/0/0')),
      verdicts.join(' '))
  }

  {
    // ★ AN UNKNOWN MODE IS NOT A GUESS. It falls back to 'tail', which is
    // the mode that always hands over.
    const run = runSandbox({ payload: bootPayload('up-boot', { enterMode: 'nonsense' }) })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.kernelReady()
    await tick()
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    const left = run.leftovers()
    // ★ AND THE FALLBACK IS *TAIL*, NOT JUST "SOMETHING THAT LEAVES".
    //
    // The behaviour above only proves the fallback is not 'click': 'tail' and
    // 'end' both hand over, so the screen leaving does not tell the two
    // apart. The value is therefore pinned in the source, where it is
    // written down and cannot drift.
    const fallsBackToTail = /function\s+enterMode\s*\(\s*\)\s*\{[^}]*return\s+'tail'/.test(BOOT_CODE)
    record('#30 an unknown enterMode falls back to tail — the screen still hands over, and the fallback is tail itself',
      left.layers === 0 && left.styles === 0 && left.videos === 0 && fallsBackToTail,
      'left=' + JSON.stringify(left) + ' fallsBackToTail=' + String(fallsBackToTail))
  }

  {
    // ★ 'media' PLAYS THE MATERIAL THE SLOT NAMES.
    const run = runSandbox({
      payload: bootPayload('up-boot', { source: 'media' }),
      catalog: { entries: [entry('up-boot'), entry('up-other')] },
    })
    await tick()
    await run.clock.advance(10)
    const videos = run.videos()
    // ★ THE FAKE DOM KEEPS `src` AS A PROPERTY. Reading the attribute
    // returns an empty string and the assertion would fail for the wrong
    // reason.
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#31 source=media plays the material the slot names, and nothing else',
      src.includes('up-boot') && !src.includes('up-other'),
      'src=' + src)
  }

  {
    // ★ 'pool' PLAYS A MATERIAL OUT OF THE LIBRARY.
    //
    // The point of the mode is that the boot clip is not the one the slot
    // names, so the material on the screen has to come from the library.
    // Which one it is, is not asserted — the point is that it is one of
    // the library's, and that it is NOT the named one.
    const run = runSandbox({
      payload: bootPayload('up-boot', { source: 'pool' }),
      catalog: { entries: [entry('up-boot'), entry('up-other'), entry('up-third')] },
    })
    await tick()
    await run.clock.advance(10)
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    const fromLibrary = ['up-boot', 'up-other', 'up-third'].some((id) => src.includes(id))
    record('#32 source=pool plays a material out of the library',
      fromLibrary,
      'src=' + src)
  }

  {
    // ★ AND THE POOL DOES NOT PICK THE SAME CLIP TWICE IN A ROW.
    //
    // With a library of two, a pick that ignores the history shows the
    // same clip on every start, which is the same as having no pool at all.
    const sources = []
    // ★ THE HISTORY IS SHARED BY EVERY SANDBOX, EXACTLY AS A REAL SESSION
    // STORAGE IS — so the rounds below are four starts of one session, and
    // the history carries over. It is cleared first so the test does not
    // depend on what ran before it.
    const first = runSandbox({ payload: bootPayload('up-boot', { source: 'pool' }), catalog: { entries: [entry('up-boot'), entry('up-other')] } })
    first.resetSession()
    for (let round = 0; round < 4; round += 1) {
      const run = runSandbox({
        payload: bootPayload('up-boot', { source: 'pool' }),
        catalog: { entries: [entry('up-boot'), entry('up-other')] },
      })
      await tick()
      await run.clock.advance(10)
      await tick()
      await tick()
      const videos = run.videos()
      sources.push(videos.length > 0 ? String(videos[0].src || '') : '')
    }
    const adjacent = sources.slice(1).filter((src, index) => src === sources[index])
    record('#33 the pool does not show the same clip twice in a row',
      adjacent.length === 0,
      'picks=' + JSON.stringify(sources))
  }

  /* ---- the boot material pool ------------------------------------------ */

  {
    // ★ THE POOL NARROWS THE PICK.
    //
    // The pool is a list of material ids, and only those may be played. The
    // library holds more than the pool does, so a pool that is ignored would
    // show a material the user never put in the pool.
    //
    // ★ THE HISTORY IS SEEDED, SO THE PICK IS A FACT AND NOT A COIN. The
    // pool member is already in the rotation history, so the surface has to
    // play it — and the materials outside the pool are the fresh ones. A
    // pool that is ignored plays one of those instead.
    const run = runSandbox({
      payload: bootPayload('up-other', { source: 'pool', pool: ['up-pool'] }),
      catalog: { entries: [entry('up-other'), entry('up-third'), entry('up-pool')] },
      random: 0,
    })
    run.resetSession()
    fakeSessionStorage.setItem(RECENT_KEY, JSON.stringify(['up-pool']))
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#42 the pool narrows the pick — only a material the user put in the pool is played',
      src === '/appearance-media/media/up-pool',
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ THE FALLBACK STAYS INSIDE THE POOL.
    //
    // A material that cannot be played must not leave the screen on a bare
    // gradient while the library still holds usable ones — but the ones it
    // may fall back to are the ones IN THE POOL. A material the user did not
    // put in the pool must never be played, not even as the replacement for
    // one that cannot be played.
    //
    // ★ EVERY MATERIAL IN THE POOL IS BROKEN HERE, so the fallback has
    // nowhere to go, and the material outside the pool is playable. The
    // surface must play NOTHING: the fallback is not allowed to leave the
    // pool.
    const run = runSandbox({
      payload: bootPayload('up-broken-a', { source: 'pool', pool: ['up-broken-a', 'up-broken-b'] }),
      catalog: {
        entries: [
          entry('up-broken-a', 'clip'),
          entry('up-broken-b', 'clip'),
          entry('up-outside'),
        ],
      },
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#43 a material that cannot be played falls back inside the pool — never to a material outside it',
      videos.length === 0 && src === '',
      'videos=' + String(videos.length) + ' src=' + src
      + ' lastResult=' + String(run.boot?.state?.().lastResult))
  }

  {
    // ★ A POOL ID THAT IS NOT IN THE LIBRARY IS NOT A MATERIAL.
    //
    // The user deleted the clip. The id names nothing that can be played, so
    // that one is ignored — and the pool that is left still works.
    const run = runSandbox({
      payload: bootPayload('up-other', { source: 'pool', pool: ['up-gone', 'up-pool'] }),
      catalog: { entries: [entry('up-other'), entry('up-pool')] },
      random: 0,
    })
    run.resetSession()
    fakeSessionStorage.setItem(RECENT_KEY, JSON.stringify(['up-pool']))
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#44 a pool id that is not in the library is ignored — the pool is what is left of it',
      src === '/appearance-media/media/up-pool',
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ A POOL THAT IS EMPTY IN THE LIBRARY FALLS BACK TO THE WHOLE LIBRARY.
    //
    // Every id the user put in the pool names a material that is gone. A
    // pool that cannot narrow anything does not narrow anything — the same
    // rule an empty pool follows.
    const run = runSandbox({
      payload: bootPayload('up-absent', { source: 'pool', pool: ['up-gone-1', 'up-gone-2'] }),
      catalog: { entries: [entry('up-other'), entry('up-third')] },
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    const fromLibrary = src === '/appearance-media/media/up-other'
      || src === '/appearance-media/media/up-third'
    record('#45 a pool whose materials are all gone falls back to the whole library',
      videos.length === 1 && fromLibrary,
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ THE ROTATION STILL WORKS INSIDE THE POOL.
    //
    // A pool of two materials is a rotation, not a coin: the two must
    // alternate. The history is what makes it so, and the history is
    // remembered per material — a pool of its own does not turn it off.
    const picks = []
    const scenario = {
      payload: bootPayload('up-other', { source: 'pool', pool: ['up-a', 'up-b'] }),
      catalog: { entries: [entry('up-a'), entry('up-b')] },
      random: 0,
    }
    const first = runSandbox(scenario)
    first.resetSession()
    for (let round = 0; round < 4; round += 1) {
      const run = runSandbox(scenario)
      await tick()
      await run.clock.advance(10)
      await tick()
      await tick()
      const videos = run.videos()
      picks.push(videos.length > 0 ? String(videos[0].src || '') : '')
    }
    const adjacent = picks.slice(1).filter((src, index) => src === picks[index])
    // ★ AND THE HISTORY'S KEY IS PINNED. A scenario that seeds the history
    // has to seed the key the surface reads, and a surface that moved the
    // key would turn every pool scenario into a coin.
    const keyPinned = BOOT_CODE.includes("'" + RECENT_KEY + "'")
    record('#46 the pool does not play the same material twice in a row — inside the pool too',
      adjacent.length === 0 && keyPinned,
      'picks=' + JSON.stringify(picks) + ' keyPinned=' + String(keyPinned))
  }

  {
    // ★ A POOL WITH ONE MATERIAL ALWAYS PLAYS THAT MATERIAL.
    //
    // "Not the same one twice in a row" is trivially true for one material,
    // and a picker that hunts for a fresh candidate would hunt forever. The
    // screen must play the one material the pool holds.
    const run = runSandbox({
      payload: bootPayload('up-other', { source: 'pool', pool: ['up-solo'] }),
      catalog: { entries: [entry('up-other'), entry('up-solo')] },
      random: 0,
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#47 a pool with one material always plays that material, and it does not hunt for another one',
      src === '/appearance-media/media/up-solo',
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ AN EMPTY POOL IS THE WHOLE LIBRARY.
    //
    // The configuration carries an empty list, not a missing field: the pool
    // the user never narrowed is the whole library, and that is the
    // behaviour the pool mode had before the pool could be narrowed.
    const run = runSandbox({
      payload: bootPayload('up-absent', { source: 'pool', pool: [] }),
      catalog: { entries: [entry('up-other'), entry('up-third')] },
      random: 0,
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    const fromLibrary = src === '/appearance-media/media/up-other'
      || src === '/appearance-media/media/up-third'
    record('#53 an empty pool is the whole library — the pool mode is not narrowed by nothing',
      videos.length === 1 && fromLibrary,
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ THE POOL DOES NOT NARROW THE MATERIAL THE SLOT NAMES.
    //
    // The pool is the pool the RANDOM PICK is made from — that is what the
    // configuration's own documentation says about the field. In 'media'
    // mode nothing is picked: the user named the material, and a list of
    // random picks has nothing to say about it. A pool that silently
    // swallowed the named material would be a surprise, and the 'media' mode
    // must keep doing what it always did.
    const run = runSandbox({
      payload: bootPayload('up-boot', { source: 'media', pool: ['up-other'] }),
      catalog: { entries: [entry('up-boot'), entry('up-other')] },
      random: 0,
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#55 the pool does not narrow the material the slot names — source=media still plays it',
      src === '/appearance-media/media/up-boot',
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ THE HAND-OVER WAITS FOR THE APPLICATION.
    //
    // The clip can end before the kernel is ready — a short clip on a slow
    // start. The screen must hold the last frame and wait, and it must hand
    // over the moment the readiness signal arrives. Tearing the screen down
    // over an empty shell is the "flash of nothing" a user sees as a bug.
    const run = runSandbox({ payload: bootPayload('up-boot', { enterMode: 'end' }) })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    const waiting = run.leftovers()
    const caption = run.dom.body.children
      .filter((child) => child.className === 'dsham-boot-layer')
      .flatMap((child) => child.children)
      .flatMap((child) => child.children ?? [])
      .find((child) => child.className === 'dsham-boot-caption')
    record('#34 a clip that ends before the application is ready holds the last frame, and says so',
      waiting.layers > 0
      && String(caption?.textContent).includes('启动较慢'),
      'left=' + JSON.stringify(waiting) + ' caption=' + String(caption?.textContent))

    // ★ AND IT HANDS OVER AS SOON AS THE APPLICATION IS READY.
    run.kernelReady()
    await tick()
    await run.clock.advance(3000)
    const after = run.leftovers()
    record('#35 and it hands over the moment the application is ready',
      after.layers === 0 && after.styles === 0 && after.videos === 0,
      'left=' + JSON.stringify(after))
  }

  {
    // ★ A MATERIAL THAT CANNOT BE PLAYED IS NOT LOOKED UP AGAIN ON EVERY
    // POLL.
    //
    // In click mode the screen never leaves on its own, so a failed material
    // would be looked up again every second: the caption would flicker
    // between two texts and the media element would be created and
    // destroyed over and over. The failure is a state, not a retry.
    // ★ THE POOL MODE, BECAUSE THE ROTATION HISTORY ONLY EXISTS THERE. In
    // 'media' mode the material is the one the slot names and there is
    // nothing to rotate.
    const run = runSandbox({
      payload: bootPayload('up-boot', { enterMode: 'click', source: 'pool' }),
      catalog: { entries: [entry('up-boot'), entry('up-other')] },
    })
    // ★ THE COUNTER STARTS AT ZERO. It is shared by every sandbox in the
    // suite, so the count that matters is this scenario's own.
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const before = run.dom.calls.filter((call) => call.startsWith('create:VIDEO')).length
    // ★ THE ROTATION HISTORY IS WRITTEN ONCE PER PLAYED MATERIAL. A pick
    // that was never played must not be remembered: the history is written
    // where the material is applied, not where it is chosen — the chooser
    // runs on every poll, and a history written there fills up with picks
    // that never played.
    const writesBefore = run.sessionWrites()
    if (videos.length > 0) videos[0].dispatch('error')
    await run.clock.advance(10)
    const afterFail = run.dom.calls.filter((call) => call.startsWith('create:VIDEO')).length
    const writesAfterFail = run.sessionWrites()
    // ★ FIVE POLLS' WORTH OF TIME. The refresh is a promise chain, so the
    // clock alone is not enough — the chain has to be given a chance to
    // land, or the test would pass because nothing had happened yet.
    await run.clock.advance(5000)
    await tick()
    await tick()
    await tick()
    const later = run.dom.calls.filter((call) => call.startsWith('create:VIDEO')).length
    const writesLater = run.sessionWrites()
    // ★ TWO THINGS MUST NOT GROW: the number of media elements (the failed
    // material is not looked up again) and the number of writes to the
    // rotation history (a pick that was never played is not remembered).
    //
    // ★ AND THE TWO GUARDS THAT MAKE IT TRUE ARE ASSERTED IN THE SOURCE, so
    // the claim can go red even when the behaviour happens to be unreachable
    // in this scenario. A check that cannot fail is not a check, and the
    // behaviour alone does not prove where it comes from.
    const failedIsTerminal = /clipState === 'failed'\) return null/.test(BOOT_CODE)
    record('#36 a material that failed is not looked up again on every poll, and it does not eat the rotation history',
      later === afterFail && afterFail === before
      && writesLater === writesBefore
      && writesBefore === 1
      && failedIsTerminal,
      'created before=' + String(before) + ' afterFail=' + String(afterFail) + ' later=' + String(later)
      + ' | writes before=' + String(writesBefore) + ' (must be 1: one played material, one write)'
      + ' afterFail=' + String(writesAfterFail) + ' later=' + String(writesLater)
      + ' | failedIsTerminal=' + String(failedIsTerminal))
  }

  {
    // ★ THE UPPER BOUND WAITS FOR THE APPLICATION TOO.
    //
    // Three paths leave this screen and all three ask the same question
    // first: is the application up? The one that forgot to ask is the one
    // that hands the viewport over to an empty shell.
    const run = runSandbox({ payload: bootPayload('up-boot', { enterMode: 'end' }) })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    const video = run.videos()[0]
    video.duration = Number.POSITIVE_INFINITY
    // ★ NINETEEN SECONDS — BEFORE THE UPPER BOUND AND BEFORE THE KERNEL
    // BOUND. The screen has to still be up: neither the upper bound nor the
    // kernel has said anything yet.
    await run.clock.advance(19000)
    const waiting = run.leftovers()
    // ★ AND THE GATE IS ASSERTED IN THE SOURCE, because the BEHAVIOUR alone
    // cannot tell it apart from its absence: by the time the upper bound
    // fires, the kernel is already ready in this scenario, so the gate makes
    // no difference to the outcome. A gate that is never exercised is a
    // gate that does not exist, and this is the assertion that notices when
    // somebody deletes it.
    const endlessGate = /function\s+onMediaEndless[\s\S]*?kernelReady !== true[\s\S]*?beginHandover\('endless'\)/.test(BOOT_CODE)
    record('#37 the upper bound waits for the application as well — at nineteen seconds the screen is still up',
      waiting.layers > 0 && endlessGate,
      'left=' + JSON.stringify(waiting) + ' endlessGate=' + String(endlessGate))

    run.kernelReady()
    await tick()
    // ★ THE UPPER BOUND IS TWENTY SECONDS AWAY, AND THE HANDOVER TAKES THE
    // FADE ON TOP OF THAT. Six seconds covers both.
    await run.clock.advance(6000)
    const after = run.leftovers()
    record('#38 and it hands over once the application is ready',
      after.layers === 0 && after.styles === 0 && after.videos === 0,
      'left=' + JSON.stringify(after))
  }

  {
    // ★ A KERNEL THAT FAILS LETS THE SCREEN GO.
    //
    // The Host's readiness deferred has a reject path. When it takes it,
    // there is no application to wait for, and the screen must not sit on
    // top of the viewport pretending one is coming.
    const run = runSandbox({ payload: bootPayload('up-boot', { enterMode: 'end' }) })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    const waiting = run.leftovers()
    run.kernelFailed()
    await tick()
    await tick()
    await run.clock.advance(3000)
    const after = run.leftovers()
    record('#39 a kernel that fails lets the screen go — it does not sit on the viewport forever',
      waiting.layers > 0 && after.layers === 0 && after.styles === 0 && after.videos === 0,
      'waiting=' + JSON.stringify(waiting) + ' after=' + JSON.stringify(after))
  }

  {
    // ★ A KERNEL THAT NEVER ANSWERS ALSO LETS THE SCREEN GO.
    //
    // The readiness signal is polled with a bound — twenty seconds. When the
    // bound runs out, the application is not coming, and the screen has to
    // give up. Without this, the gate that waits for the kernel would wait
    // forever, and the user would be looking at a dead picture on top of
    // their application with no way past it.
    const run = runSandbox({ payload: bootPayload('up-boot', { enterMode: 'end' }) })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    const waiting = run.leftovers()
    // ★ TWENTY SECONDS PLUS A BIT.
    await run.clock.advance(25000)
    await tick()
    await tick()
    await tick()
    const after = run.leftovers()
    record('#40 a kernel that never answers lets the screen go after its bound — the screen is not a dead picture',
      waiting.layers > 0 && after.layers === 0 && after.styles === 0 && after.videos === 0,
      'waiting=' + JSON.stringify(waiting) + ' after=' + JSON.stringify(after))
  }

  {
    // ★ A HOST THAT NEVER CREATES THE READINESS SIGNAL.
    //
    // The deferred is created by a script at the end of the body. A Host
    // that fails before it gets there never creates it, and the surface
    // polls for it with a bound. When the bound runs out, the screen has to
    // let go — otherwise it sits on the viewport forever.
    const run = runSandbox({ noGate: true, payload: bootPayload('up-boot', { enterMode: 'end' }) })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    const waiting = run.leftovers()
    // ★ TWENTY SECONDS PLUS THE FADE.
    await run.clock.advance(25000)
    await tick()
    await tick()
    await tick()
    const after = run.leftovers()
    record('#41 a Host that never creates the readiness signal lets the screen go after the bound',
      waiting.layers > 0 && after.layers === 0 && after.styles === 0 && after.videos === 0,
      'waiting=' + JSON.stringify(waiting) + ' after=' + JSON.stringify(after))
  }

  /* ---- the negative controls ----------------------------------------- */

  {
    // ★ A BOOT CLIP THAT LOOPS HOLDS THE VIEWPORT FOREVER. The arbitration
    // point decides the loop flag per slot; the broken copy gets it wrong.
    const broken = mutate(CONTROLLER_TEXT,
      "var LOOP_BY_SLOT = { background: true, boot: false, screensaver: true }",
      "var LOOP_BY_SLOT = { background: true, boot: true, screensaver: true }",
      'the boot slot loops')
    const run = runSandbox({ payload: bootPayload(), controller: broken })
    await tick()
    await run.clock.advance(10)
    const video = run.videos()[0]
    const loop = video === undefined ? null : video.loop
    record('#20 REVERSE CONTROL: a looping boot clip breaks the "does not loop" assertion',
      loop === true, 'loop=' + String(loop))
  }

  {
    // ★ AN UPPER BOUND THAT NEVER EXPIRES IS NOT AN UPPER BOUND.
    const broken = mutate(BOOT_TEXT,
      'var ENDLESS_MS = 20000',
      'var ENDLESS_MS = 600000',
      'the upper bound never expires')
    const run = runSandbox({ payload: bootPayload(), boot: broken })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.videos()[0].duration = Number.POSITIVE_INFINITY
    await run.clock.advance(21000)
    const left = run.leftovers().layers
    record('#21 REVERSE CONTROL: an upper bound that never expires breaks the bound assertion',
      left === 1, 'layers=' + String(left))
  }

  {
    // ★ AN ADAPTER THAT DOES NOT CLEAR THE SOURCE BREAKS THE RELEASE ORDER.
    const broken = mutate(RENDERERS_TEXT,
      "        video.removeAttribute('src')\n",
      '',
      'the adapter does not clear the source')
    const run = runSandbox({ payload: bootPayload(), renderers: broken })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    const verdict = releaseOrder(run.dom.calls)
    record('#22 REVERSE CONTROL: an adapter that does not clear the source breaks the order',
      verdict.ok === false, verdict.detail)
  }

  {
    // ★ A RELEASE THAT DISCONNECTS THE OBSERVER BEFORE THE MEDIA IS RELEASED
    // BREAKS THE ORDER.
    const broken = mutate(BOOT_TEXT,
      '      // ① the media: pause → clear the source → unbind its listeners.\n      releaseMedia()',
      '      // ① the media: pause → clear the source → unbind its listeners.\n      if (observer !== null) { observer.disconnect(); observer = null }\n      releaseMedia()',
      'the observer is disconnected too early')
    const run = runSandbox({ payload: bootPayload(), boot: broken })
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    const verdict = releaseOrder(run.dom.calls)
    record('#23 REVERSE CONTROL: an early disconnect breaks the order', verdict.ok === false, verdict.detail)
  }

  {
    // ★ A SURFACE THAT NEVER RELEASES ITS SLOT LEAVES THE BACKGROUND ON THE
    // FLOOR. The hand-over is the release.
    const broken = mutate(BOOT_TEXT,
      '    try {\n      controller.release(SLOT)\n    } catch (error) {',
      '    try {\n      /* the reverse control: the slot is never released */\n    } catch (error) {',
      'the slot is never released')
    const run = runSandbox({
      payload: slotsPayload({
        slots: {
          boot: { enabled: true, mediaId: 'up-boot', revision: 3 },
          background: { enabled: true, mediaId: 'up-bg', revision: 4 },
        },
      }),
      catalog: catalogPayload([entry('up-boot'), entry('up-bg')]),
      boot: broken,
    })
    const mounted = []
    run.controller.registerHost('background', {
      createElement(tag) { return run.dom.createElement(tag) },
      mount(element) { mounted.push(element) },
      unmount() {},
      ensure() { return true },
      resolve() { return Promise.resolve(entry('up-bg')) },
    })
    // ★ THE BACKGROUND IS ON THE STAGE FIRST, so the boot clip is the one
    // that pushes it off.
    run.controller.apply('background', entry('up-bg'))
    await tick()
    await run.clock.advance(10)
    paintFrame(run)
    run.videos()[0].dispatch('ended')
    await run.clock.advance(3000)
    await tick()
    await tick()
    const after = mounted.length
    record('#24 REVERSE CONTROL: a hand-over that does not release the slot leaves the background down',
      after === 1, 'mountedAfter=' + String(after))
  }

  {
    // ★ THE THREE HAND-OVER PATHS ARE NOT DECORATIVE. Take the kernel-ready
    // exit away and the screen with nothing to show holds the viewport.
    const broken = mutate(BOOT_TEXT,
      "    if (kernelReady === true && evaluated === true && clipState === 'none') {\n      beginHandover('kernel-ready')\n    }",
      "    if (false && kernelReady === true && evaluated === true && clipState === 'none') {\n      beginHandover('kernel-ready')\n    }",
      'the kernel-ready exit never fires')
    const run = runSandbox({ payload: slotsPayload(), boot: broken })
    await tick()
    await run.clock.advance(10)
    run.kernelReady()
    await tick()
    await run.clock.advance(3000)
    const left = run.leftovers()
    record('#25 REVERSE CONTROL: without the kernel-ready exit the screen with nothing to show never leaves',
      left.layers === 1, 'left=' + JSON.stringify(left))
  }

  {
    // ★ THE YIELDING GOES THROUGH A CLEAN STAGE HANDOVER, AND THE WATCHER
    // STAYS. The other plugin's marker is read, never written.
    const run = runSandbox({ payload: bootPayload(), wallpaper: 'on' })
    await tick()
    await run.clock.advance(10)
    const left = run.leftovers()
    const bodyWrites = run.dom.calls.filter((call) => call.startsWith('body.setAttribute')
      || call.startsWith('body.removeAttribute'))
    record('#26 another wallpaper plugin on the stage: the boot screen yields, and the marker is only read',
      left.layers === 0 && left.videos === 0 && bodyWrites.length === 0,
      'left=' + JSON.stringify(left) + ' bodyWrites=' + JSON.stringify(bodyWrites))
  }

  {
    // ★ AND THE BOOT SCREEN COMES BACK WHEN THE OTHER PLUGIN LEAVES.
    const run = runSandbox({ payload: bootPayload() })
    await tick()
    await run.clock.advance(10)
    const before = run.leftovers().layers
    run.dom.body.setAttribute('data-we-wallpaper', 'on')
    await tick()
    await run.clock.advance(10)
    const yielded = run.leftovers().layers
    run.dom.body.removeAttribute('data-we-wallpaper')
    await tick()
    await run.clock.advance(2000)
    const back = run.leftovers().layers
    record('#27 the boot screen comes back when the other plugin leaves the stage',
      before === 1 && yielded === 0 && back === 1,
      'before=' + String(before) + ' yielded=' + String(yielded) + ' back=' + String(back))
  }

  {
    // ★ A POOL THAT IS IGNORED NARROWS NOTHING. The broken copy throws the
    // pool away, and then the pick is a material the user never put in the
    // pool — which is what assertion #42 forbids.
    const broken = mutate(BOOT_TEXT,
      'if (ids.length === 0) return entries',
      'if (true) return entries',
      'the pool is ignored')
    const run = runSandbox({
      payload: bootPayload('up-other', { source: 'pool', pool: ['up-pool'] }),
      catalog: { entries: [entry('up-other'), entry('up-third'), entry('up-pool')] },
      random: 0,
      boot: broken,
    })
    run.resetSession()
    fakeSessionStorage.setItem(RECENT_KEY, JSON.stringify(['up-pool']))
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#48 REVERSE CONTROL: a pool that is ignored breaks the narrowing',
      src === '/appearance-media/media/up-other',
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ THE FALLBACK MUST NOT LEAVE THE POOL. The broken copy builds the
    // fallbacks out of the whole library, and the material outside the pool
    // is played — which is what assertion #43 forbids.
    const broken = mutate(BOOT_TEXT,
      'var rest = shuffled(candidates)',
      'var rest = shuffled(entries)',
      'the fallback leaves the pool')
    const run = runSandbox({
      payload: bootPayload('up-broken-a', { source: 'pool', pool: ['up-broken-a', 'up-broken-b'] }),
      catalog: {
        entries: [
          entry('up-broken-a', 'clip'),
          entry('up-broken-b', 'clip'),
          entry('up-outside'),
        ],
      },
      boot: broken,
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#49 REVERSE CONTROL: a fallback that leaves the pool breaks the fallback rule',
      videos.length === 1 && src === '/appearance-media/media/up-outside',
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ A POOL THAT IS EMPTY IN THE LIBRARY MUST FALL BACK TO THE LIBRARY.
    // The broken copy hands back an empty list, and nothing is played — which
    // is what assertion #45 forbids.
    const broken = mutate(BOOT_TEXT,
      'if (allowed.length === 0) return entries',
      'if (allowed.length === 0) return allowed',
      'the pool does not fall back to the library')
    const run = runSandbox({
      payload: bootPayload('up-absent', { source: 'pool', pool: ['up-gone-1', 'up-gone-2'] }),
      catalog: { entries: [entry('up-other'), entry('up-third')] },
      boot: broken,
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    record('#50 REVERSE CONTROL: a pool that does not fall back to the library breaks the fallback rule',
      videos.length === 0,
      'videos=' + String(videos.length)
      + ' lastResult=' + String(run.boot?.state?.().lastResult))
  }

  {
    // ★ THE ROTATION MUST STILL WORK INSIDE THE POOL. The broken copy throws
    // the history away, and the same material is played over and over —
    // which is what assertion #46 forbids.
    const broken = mutate(BOOT_TEXT,
      '    var recent = readRecent()\n    var fresh = []',
      '    var recent = readRecent()\n    var fresh = entries.slice()',
      'the rotation history is ignored')
    const picks = []
    const scenario = {
      payload: bootPayload('up-other', { source: 'pool', pool: ['up-a', 'up-b'] }),
      catalog: { entries: [entry('up-a'), entry('up-b')] },
      random: 0,
      boot: broken,
    }
    const first = runSandbox(scenario)
    first.resetSession()
    for (let round = 0; round < 4; round += 1) {
      const run = runSandbox(scenario)
      await tick()
      await run.clock.advance(10)
      await tick()
      await tick()
      const videos = run.videos()
      picks.push(videos.length > 0 ? String(videos[0].src || '') : '')
    }
    const adjacent = picks.slice(1).filter((src, index) => src === picks[index])
    record('#51 REVERSE CONTROL: a rotation history that is ignored breaks the rotation',
      adjacent.length > 0,
      'picks=' + JSON.stringify(picks))
  }

  {
    // ★ A POOL WITH ONE MATERIAL IS STILL A POOL. The broken copy treats a
    // one-material pool as no pool at all, and plays a material the user
    // never put in the pool — which is what assertion #47 forbids.
    const broken = mutate(BOOT_TEXT,
      'if (ids.length === 0) return entries',
      'if (ids.length <= 1) return entries',
      'a one-material pool is ignored')
    const run = runSandbox({
      payload: bootPayload('up-other', { source: 'pool', pool: ['up-solo'] }),
      catalog: { entries: [entry('up-other'), entry('up-solo')] },
      random: 0,
      boot: broken,
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    const src = videos.length > 0 ? String(videos[0].src || '') : ''
    record('#52 REVERSE CONTROL: a one-material pool that is ignored breaks the pool rule',
      src === '/appearance-media/media/up-other',
      'src=' + src + ' videos=' + String(videos.length))
  }

  {
    // ★ AN EMPTY POOL MUST STILL BE THE WHOLE LIBRARY. The broken copy hands
    // back an empty list, and nothing is played — which is what assertion
    // #53 forbids.
    const broken = mutate(BOOT_TEXT,
      'if (ids.length === 0) return entries',
      'if (ids.length === 0) return []',
      'an empty pool is not the whole library')
    const run = runSandbox({
      payload: bootPayload('up-absent', { source: 'pool', pool: [] }),
      catalog: { entries: [entry('up-other'), entry('up-third')] },
      random: 0,
      boot: broken,
    })
    run.resetSession()
    await tick()
    await run.clock.advance(10)
    await tick()
    await tick()
    const videos = run.videos()
    record('#54 REVERSE CONTROL: an empty pool that is not the whole library breaks the empty-pool rule',
      videos.length === 0,
      'videos=' + String(videos.length)
      + ' lastResult=' + String(run.boot?.state?.().lastResult))
  }

  /* ---- the notes ------------------------------------------------------ */

  notes.push('the boot surface, the adapters and the arbitration point are evaluated as text in a node:vm context with a fake DOM and a fake clock')
  notes.push('the release order is read item by item out of the action log; the reads are kept in a separate log')
  notes.push('the three hand-over paths are driven by the real event, the real clock and the real readiness deferred')
} catch (error) {
  record('the suite ran to completion', false, String(error && error.message ? error.message : error))
}

/* ---- the report -------------------------------------------------------- */

for (const [label, ok, detail] of checks) {
  const mark = ok ? 'PASS' : 'FAIL'
  const number = label.match(/^#\d+/)
  const prefix = number === null ? '' : number[0] + ' '
  console.log(mark + '  ' + prefix + label.slice(number === null ? 0 : number[0].length).trim()
    + (detail === '' ? '' : '  — ' + detail))
}
for (const note of notes) {
  console.log('NOTE  ' + note)
}

const failed = checks.filter(([, ok]) => !ok).length
console.log(String(checks.length) + ' check(s), ' + String(failed) + ' failed')
exitCode = failed === 0 ? 0 : 1

if (exitCode !== 0) {
  console.error('the boot screen acceptance FAILED')
  process.exitCode = exitCode
}
