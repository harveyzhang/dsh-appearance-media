#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the chat background surface.
//
// What it proves, and what it deliberately does not:
//
//   * it EVALUATES THE REAL SOURCE TEXT of `src/background.js` — the very
//     bytes the Host pushes into the page — next to the real adapters and the
//     real arbitration point, inside a `node:vm` context with a fake DOM, a
//     fake Host route and a fake clock;
//   * it never starts DSH, never binds a port, never opens a browser.
//
// ★ WHY IT EVALUATES THE TEXT INSTEAD OF IMPORTING A MODULE.
//
// The file is SCRIPT TEXT: the Host pushes it into the page as an inline
// `kind:'script'` row. There is no module to import, and there must not be
// one: a `require` in that text is a syntax error in the page. So the suite
// runs the text the way the browser runs it.
//
// ★ WHY THE REAL ADAPTERS AND THE REAL ARBITRATION POINT ARE IN THE LOOP.
//
// The release order this suite asserts is a CONTRACT that spans three files:
// the surface asks the arbitration point to release, the arbitration point
// asks the adapter to dispose, and the adapter is the one that pauses and
// clears the source. A fake adapter would let the suite assert an order the
// real code does not have.
//
// ★ EVERY ASSERTION HERE CAN FAIL BECAUSE THE IMPLEMENTATION IS WRONG, AND
// THE ORDER AND THE YIELDING ASSERTIONS HAVE A NEGATIVE CONTROL.
//
// A check that has never failed is not a check. So the order assertion and
// the yielding assertion are run a second time against a deliberately broken
// copy of the source, and the broken copy MUST produce a different verdict.
//
// The holes this suite is written against:
//
//   * the transparent CSS must hit `body` and `[class*="_frame"]` — the frame's
//     class is hashed, so only a substring match survives the next build, and
//     `[class*="frame"]` would hit classes this build uses for something else;
//   * `z-index` must be `0` — the body's own background is opaque, so a layer
//     below it is invisible;
//   * the yielding marker is READ, never written, and the body carries no
//     attribute at all;
//   * the media URL comes from `entry.mediaUrl` and from nowhere else;
//   * the release order — pause, clear the source, unbind, disconnect, clear
//     the timer, remove the elements — item by item;
//   * after the release, not one of our elements is left on the page;
//   * `visibilitychange` releases, and coming back re-applies;
//   * the other plugin's marker makes this surface withdraw.
//
// Usage: node tools/verify-background.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BACKGROUND_PATH = fileURLToPath(new URL('../src/background.js', import.meta.url))
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

/** The background surface's source text. */
const BACKGROUND_TEXT = readFileSync(BACKGROUND_PATH, 'utf8')
/** The adapters' source text. */
const RENDERERS_TEXT = readFileSync(RENDERERS_PATH, 'utf8')
/** The arbitration point's source text. */
const CONTROLLER_TEXT = readFileSync(CONTROLLER_PATH, 'utf8')

/**
 * Remove the comments from a source text.
 *
 * ★ STRING-AWARE. A `//` inside a string literal is not a comment, and a
 * `http://` inside a string literal is not one either — a naive regex stripper
 * would cut a URL in half and change what the scan reads.
 *
 * @param text - the source text.
 * @returns the text with its comments removed.
 */
function stripComments(text) {
  let out = ''
  let i = 0
  let quote = null
  while (i < text.length) {
    const ch = text[i]
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        if (i + 1 < text.length) { out += text[i + 1]; i += 2; continue }
      } else if (ch === quote) {
        quote = null
      }
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      i += 2
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * The shapes that must not appear in an injected script.
 *
 * ★ THE ONE EXCEPTION IS PRECISE, NOT A BLANKET "NO ATTRIBUTE WRITES".
 *
 * The surface writes ONE attribute of its own — `data-dsham-bg` on the
 * ROOT element — to say "the media is on the stage" (the theme-alias
 * overrides are scoped to it). That write is allowed, and it is allowed
 * only in that exact shape: `root.setAttribute(BACKGROUND_MARKER, …)` and
 * `root.removeAttribute(BACKGROUND_MARKER)`.
 *
 * Everything else stays forbidden: the body is never written to (the other
 * plugin's marker lives there), and the other plugin's marker is never
 * written at all.
 *
 * @param text - the source text.
 * @returns the labels of the shapes that were found.
 */
function forbiddenShapes(text) {
  // ★ STRIP THE COMMENTS FIRST.
  //
  // A comment is not code. A comment that NAMES a forbidden shape — "this is
  // not a `setAttribute` call" — used to fail the scan, because the scan read
  // the word and not the code. That is the same class of bug this suite was
  // built to catch: a check that fails for the wrong reason is a check nobody
  // can act on, and the fix is always to look at what the check actually
  // measures.
  //
  // ★ THE STRIP IS NOT NAIVE. A `//` inside a string is not a comment, and a
  // `http://` inside a string is not one either. So the stripper walks the
  // text and tracks whether it is inside a string literal.
  let scanned = stripComments(text)
  // ★ Strip the ONE allowed write before the scan: the scan then answers
  // "is there any attribute write that is NOT our own root marker".
  const allowed = [
    /root\.setAttribute\s*\(\s*BACKGROUND_MARKER\s*,/g,
    /root\.removeAttribute\s*\(\s*BACKGROUND_MARKER\s*\)/g,
    /typeof\s+root\.(?:setAttribute|removeAttribute|toggleAttribute)\s*!==\s*'function'/g,
  ]
  for (const pattern of allowed) scanned = scanned.replace(pattern, 'ROOT_MARKER_WRITE')
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
  ]
  const found = []
  for (const [label, pattern] of shapes) {
    if (pattern.test(scanned)) found.push(label)
  }
  return found
}

/**
 * Whether the source reads the other plugin's marker and never writes it.
 *
 * Every occurrence of the marker has to be a read: the marker belongs to
 * another plugin, and a plugin that writes it breaks that plugin's cleanup.
 *
 * @param text - the source text.
 * @returns { ok, total, reads, detail }
 */
function markerIsReadOnly(text) {
  // ★ TWO markers, from two plugins: `data-we-wallpaper` on the body and
  // `data-dsvs-background` on the root element. Every occurrence of either
  // one has to be a READ.
  //
  // ★ THE COMMENTS ARE STRIPPED FIRST. The source explains the two markers
  // in prose, and a prose mention is not a use — counting it would make the
  // rule about the CODE, not about the text.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const total = (code.match(/data-we-wallpaper/g) ?? []).length
    + (code.match(/data-dsvs-background/g) ?? []).length
  const reads = (code.match(/(?:getAttribute|hasAttribute)\(\s*'data-we-wallpaper'\s*\)/g) ?? []).length
    + (code.match(/(?:getAttribute|hasAttribute)\(\s*'data-dsvs-background'\s*\)/g) ?? []).length
  return { ok: total > 0 && total === reads, total, reads }
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

/* ------------------------------------------------------------- fake DOM */

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
  /** The intervals that were armed. */
  const intervals = []
  /** The observers that were created. */
  const observers = []

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
    },
    removeAttribute(name) {
      act('body.removeAttribute:' + name)
      delete body.attributes[name]
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

  return { calls, reads, elements, intervals, observers, body, head, document, createElement, act, look, MutationObserver: FakeMutationObserver }
}

/* ----------------------------------------------------------- the sandbox */

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
 * Build the answer of the catalog route.
 * @param entries - the entries.
 * @returns the answer.
 */
function catalogPayload(entries) {
  return { ok: true, revision: 1, entries }
}

/**
 * A catalog entry, the way the catalog route publishes it.
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
 * Run the three scripts in a fresh context.
 *
 * @param options - `background`, `renderers`, `controller`, `payload`,
 *   `catalog`, `wallpaper`, `withController`.
 * @returns the sandbox and the fake DOM.
 */
function runSandbox(options = {}) {
  const dom = createFakeDom({ wallpaper: options.wallpaper })
  const backgroundText = options.background === undefined ? BACKGROUND_TEXT : options.background
  const renderersText = options.renderers === undefined ? RENDERERS_TEXT : options.renderers
  const controllerText = options.controller === undefined ? CONTROLLER_TEXT : options.controller
  const fetchLog = []
  const warnings = []
  let payload = options.payload === undefined ? slotsPayload() : options.payload
  let catalog = options.catalog === undefined ? catalogPayload([entry('up-bg')]) : options.catalog

  const sandbox = {
    console: {
      log() {},
      warn(...args) { warnings.push(args.map((arg) => String(arg)).join(' ')) },
      error() {},
    },
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval(fn, ms) {
      dom.act('setInterval')
      dom.intervals.push({ fn, ms })
      return dom.intervals.length
    },
    clearInterval(id) {
      dom.act('clearInterval')
      const index = dom.intervals.findIndex((entryRow) => entryRow.id === id)
      if (index >= 0) dom.intervals.splice(index, 1)
    },
    fetch(url, init) {
      fetchLog.push({ url, init })
      const body = url === '/appearance-media/catalog.json' ? catalog : payload
      return Promise.resolve({
        ok: true,
        status: 200,
        json() { return Promise.resolve(body) },
      })
    },
    MutationObserver: dom.MutationObserver,
    document: dom.document,
  }

  vm.createContext(sandbox)
  if (renderersText !== null) vm.runInContext(renderersText, sandbox, { filename: 'renderers.js' })
  if (controllerText !== null && options.withController !== false) {
    vm.runInContext(controllerText, sandbox, { filename: 'controller.js' })
  }
  if (backgroundText !== null) vm.runInContext(backgroundText, sandbox, { filename: 'background.js' })

  return {
    sandbox,
    dom,
    fetchLog,
    warnings,
    controller: sandbox.__DSH_APPEARANCE_CONTROLLER__,
    background: sandbox.__DSH_APPEARANCE_BACKGROUND__,
    renderers: sandbox.__DSH_APPEARANCE_RENDERERS__,
    setPayload(next) { payload = next },
    setCatalog(next) { catalog = next },
    /** The videos that are on the page right now. */
    videos() { return dom.document.querySelectorAll('video') },
    /** The layers that are on the page right now. */
    layers() {
      return dom.body.children.filter((child) => child.className === 'dsham-bg-layer')
    },
    /** The style elements that are on the page right now. */
    styles() {
      return dom.head.children.filter((child) => child.tagName === 'STYLE')
    },
  }
}

/* --------------------------------------------------- the release order */

/**
 * Read the release order out of the action log.
 *
 * ★ THE ORDER IS READ ITEM BY ITEM, NOT "SOME OF IT HAPPENED".
 *
 * Every step is located by its own marker, and the steps are compared with
 * each other. "Clear the source" must be the action IMMEDIATELY after the
 * pause — that is the rule the upstream plugin had to learn the hard way:
 * the browser keeps downloading and decoding a media element whose source is
 * still attached.
 *
 * @param calls - the action log.
 * @returns the verdict and the evidence.
 */
function releaseOrder(calls) {
  const at = (name) => calls.findIndex((call) => call === name || call.startsWith(name + ':'))
  const pause = at('pause')
  const clearSource = at('removeAttribute:src')
  const unbind = calls.findIndex((call) => call.startsWith('removeEventListener:'))
  // The surface's own listener lives on the document, so its marker carries
  // the document's prefix.
  const unbindOwn = calls.findIndex((call) => call.includes('removeEventListener:visibilitychange'))
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
    const found = forbiddenShapes(BACKGROUND_TEXT)
    record('#1 the background source is plain script text with no forbidden shape',
      found.length === 0, JSON.stringify(found))
  }

  {
    const text = BACKGROUND_TEXT
    // ★★ THIS ASSERTION IS ABOUT THE BUG THAT WAS SHIPPED ONCE.
    //
    // The earlier implementation made the host's surfaces transparent with
    // `[class*="_frame"]{background-color:transparent !important;}` — that
    // made EVERY panel of the application fully transparent, the media
    // showed through all of them, and the application stopped being
    // readable. The media looked like it had covered the interface; in
    // reality the interface was there with no背景 behind it.
    //
    // The host's theme (`dsh-client-ui-theme`) publishes its palette as
    // ALIAS custom properties on `body` (`--dsw-alias-*`), and every visible
    // surface refers to those aliases. Overriding the aliases is what makes
    // the surfaces SEMI-transparent — one rule, no component class names,
    // and it survives a theme change.
    //
    // ⇒ The rule below FORBIDS the frame rule and REQUIRES the alias
    // overrides. It is the exact inverse of the shipped bug.
    const frameRule = /\[class\*="_frame"\]\s*\{[^}]*background(?:-color)?\s*:\s*transparent[^}]*\}/.test(text)
    const aliasRule = /--dsw-alias-bg-base\s*:/.test(text)
    const sidebarAlias = /--dsw-specific-sidebar-fill\s*:/.test(text)
    const bodyRule = /html\[data-dsham-bg="on"\][^{]*\{[^}]*background-color\s*:\s*transparent/.test(text)
    const hashed = /_frame_[A-Za-z0-9]{3,}/.test(text) || /[A-Za-z]{4,}_frame\b/.test(text)
    const loose = /\[class\*="frame"\]/.test(text)
    record('#2 the transparent CSS overrides the theme aliases — it never makes a panel fully transparent',
      !frameRule && aliasRule && sidebarAlias && bodyRule && !hashed && !loose,
      'frameRule=' + String(frameRule) + ' alias=' + String(aliasRule)
      + ' sidebarAlias=' + String(sidebarAlias) + ' body=' + String(bodyRule)
      + ' hashed=' + String(hashed) + ' loose=' + String(loose))
  }

  {
    // ★ THE VARIABLE THAT ACTUALLY PAINTS THE PANELS.
    //
    // Measured in a browser against the real host, not guessed: the centre
    // panel, the message bubbles and the cards are painted by
    // `--dsw-static-neutral-bluish-00`. This plugin overrode
    // `--dsw-alias-bg-base` from the start, and that one paints almost
    // nothing — which is why the media showed through in the sidebar and
    // NOWHERE ELSE. A check that only looked for the old variable would have
    // stayed green through that whole bug.
    const neutral = BACKGROUND_TEXT.includes('--dsw-static-neutral-bluish-00:rgba(255,255,255,')
    record('#2a the panels are made translucent through the variable that paints them',
      neutral, '--dsw-static-neutral-bluish-00:rgba(…' + String(neutral))
    // ★ NO SELF-REFERENCE. A custom property whose value reads the property
    // it replaces is a CSS CYCLE: the variable becomes invalid at computed
    // value time, and every background that reads it falls back to
    // TRANSPARENT — the whole interface goes see-through. This shipped once
    // and the assertion below is what stops it shipping twice.
    // ★ THE CYCLE IS FOUND BY COMPARING NAMES, NOT BY A BACKREFERENCE. A
    // backreference inside a character class is a trap: one escaping mistake
    // turns the check into a pattern that matches nothing, and a check that
    // cannot fail is not a check. The reverse control below proves this one
    // CAN fail.
    const cycles = []
    const declRe = /(--dsw-[a-z0-9-]+)\s*:\s*([^;}]*)/g
    let decl = declRe.exec(BACKGROUND_TEXT)
    while (decl !== null) {
      const name = decl[1]
      const value = decl[2]
      if (value.indexOf('var(' + name) !== -1 || value.indexOf('var( ' + name) !== -1) cycles.push(name)
      decl = declRe.exec(BACKGROUND_TEXT)
    }
    record('#2b no variable reads the property it replaces — a cycle makes the panel transparent',
      cycles.length === 0, 'cycles=' + JSON.stringify(cycles))
    const mix = BACKGROUND_TEXT.includes('color-mix(in srgb, var(--dsham-orig-')
    record('#2c the panel colour is NOT mixed from the variable it replaces',
      !mix, 'color-mix=' + String(mix))
    // ★ THE DARK THEME HAS ITS OWN NUMBERS, measured in a browser.
    const dark = /body\[data-ds-dark-theme\]\{[^}]*--dsw-alias-bg-layer-2:rgba\(44,44,46/.test(BACKGROUND_TEXT)
    record('#2d the dark theme has its own measured panel colours',
      dark, 'dark-rule=' + String(dark))
    // ★ ONE KNOB, ONE VEIL. The sidebar was given its own, more opaque
    // value, so the navigation column showed less of the media than the rest
    // of the window and read as a washed-out patch beside it.
    const twoAlphas = BACKGROUND_TEXT.includes('--dsham-l-sidebar')
    record('#2e the sidebar shares the panel opacity — one knob, one veil',
      !twoAlphas, '--dsham-l-sidebar=' + String(twoAlphas))
  }

  {
    // ★★ THIS ASSERTION IS ABOUT THE BUG THAT WAS SHIPPED ONCE.
    //
    // A positioned element with `z-index: 0` paints ABOVE every in-flow,
    // non-positioned element — which is most of the host's interface. The
    // layer has to be `z-index: -1` so it is a backdrop and can never cover
    // anything.
    const negative = /\.dsham-bg-layer\{[^}]*z-index\s*:\s*-1/.test(BACKGROUND_TEXT)
    const zero = /\.dsham-bg-layer\{[^}]*z-index\s*:\s*0\s*[;}]/.test(BACKGROUND_TEXT)
    const positive = /\.dsham-bg-layer\{[^}]*z-index\s*:\s*[1-9]/.test(BACKGROUND_TEXT)
    record('#3 the layer sits at z-index -1 — a backdrop, never over the interface',
      negative && !zero && !positive,
      'negative=' + String(negative) + ' zero=' + String(zero) + ' positive=' + String(positive))
  }

  {
    const marker = markerIsReadOnly(BACKGROUND_TEXT)
    const writes = forbiddenShapes(BACKGROUND_TEXT)
    record('#4 the other plugin\'s marker is READ and never written',
      marker.ok && !writes.includes('an attribute write of any kind')
      && !writes.includes('a dataset write')
      && !writes.includes('a body attribute write'),
      'total=' + String(marker.total) + ' reads=' + String(marker.reads)
      + ' writes=' + JSON.stringify(writes))
  }

  {
    // ★★ THE REGRESSION THAT ACTUALLY SHIPPED ONCE, AS A STATIC RULE.
    //
    // The layer must be inserted as the body's FIRST element. The host's own
    // root is `position: fixed; z-index: 1000` and is mounted on the body;
    // a layer that ends up after it is its DOM sibling and can land in front
    // of it. `insertBefore(layer, body.firstChild)` is what puts it first.
    const inserts = /body\.insertBefore\(\s*layer\s*,\s*body\.firstChild\s*\)/.test(BACKGROUND_TEXT)
    const appendsAt = BACKGROUND_TEXT.indexOf('body.appendChild(layer)')
    const insertsAt = BACKGROUND_TEXT.indexOf('body.insertBefore(layer, body.firstChild)')
    // ★ The `appendChild` is the FALLBACK for a DOM without `insertBefore`
    // (a fake DOM in a test, an ancient engine) — it may exist, but it has
    // to come AFTER the insert, never instead of it.
    const appendIsFallback = appendsAt < 0 || (insertsAt >= 0 && appendsAt > insertsAt)
    record('#0b the layer is inserted as the body\'s FIRST element, never appended',
      inserts && appendIsFallback,
      'inserts=' + String(inserts) + ' appendIsFallback=' + String(appendIsFallback))
  }

  {
    // ★★ THE MARKER IS SCOPED TO THE ROOT ELEMENT AND IT IS EXACTLY OURS.
    //
    // The theme-alias overrides only apply while the marker is on the root
    // element. A marker on the body would collide with the other plugin's
    // marker; a marker that is never removed would leave the interface
    // translucent after the media left.
    const markerName = /var BACKGROUND_MARKER = 'data-dsham-bg'/.test(BACKGROUND_TEXT)
    const setOnRoot = /root\.setAttribute\(BACKGROUND_MARKER/.test(BACKGROUND_TEXT)
    const removed = /root\.removeAttribute\(BACKGROUND_MARKER/.test(BACKGROUND_TEXT)
    const onBody = /body\.setAttribute/.test(BACKGROUND_TEXT)
    record('#0c the marker is ours, lives on the root element, and is removed again',
      markerName && setOnRoot && removed && !onBody,
      'name=' + String(markerName) + ' set=' + String(setOnRoot)
      + ' removed=' + String(removed) + ' onBody=' + String(onBody))
  }

  {
    const handWritten = BACKGROUND_TEXT.includes('/appearance-media/media/')
    record('#5 the media URL is never hand-written',
      !handWritten, 'handWritten=' + String(handWritten))
  }

  {
    const published = BACKGROUND_TEXT.includes('globalThis.__DSH_APPEARANCE_BACKGROUND__ =')
    const ownPoint = /__DSH_APPEARANCE_CONTROLLER__\s*=[^=]/.test(BACKGROUND_TEXT)
    record('#6 the surface publishes its own global and creates no arbitration point',
      published && !ownPoint, 'published=' + String(published) + ' ownPoint=' + String(ownPoint))
  }

  /* ---- the surface on a page ---------------------------------------- */

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const state = run.background?.state?.() ?? {}
    record('#7 the surface registers itself and plays the configured material',
      run.background !== undefined && run.background !== null
      && run.background.available === true
      && run.layers().length === 1
      && run.videos().length === 1
      && state.mediaId === 'up-bg',
      'available=' + String(run.background?.available)
      + ' layers=' + String(run.layers().length) + ' videos=' + String(run.videos().length)
      + ' mediaId=' + String(state.mediaId))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const bodyWrites = run.dom.calls.filter((call) => call.startsWith('body.setAttribute')
      || call.startsWith('body.removeAttribute'))
    const bodyClass = run.dom.body.className
    record('#8 the body is only appended to: no attribute, no class, no style is written on it',
      bodyWrites.length === 0 && bodyClass === '' && run.dom.body.children.length === 1,
      'bodyWrites=' + JSON.stringify(bodyWrites) + ' bodyClass=' + String(bodyClass)
      + ' children=' + String(run.dom.body.children.length))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const style = run.styles()[0]
    const css = style === undefined ? '' : String(style.textContent)
    record('#9 the surface publishes the transparent CSS and the layer CSS itself',
      css.includes('html[data-dsham-bg="on"]')
      && css.includes('--dsw-alias-bg-base:')
      && css.includes('--dsw-specific-sidebar-fill:')
      && css.includes('background-color:transparent !important;')
      && css.includes('.dsham-bg-layer{position:fixed;inset:0;z-index:-1;')
      && !css.includes('[class*="_frame"]')
      && !/\[class\*="frame"\]/.test(css),
      'styles=' + String(run.styles().length) + ' css=' + JSON.stringify(css.slice(0, 120)))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const layer = run.layers()[0]
    const video = run.videos()[0]
    const inside = layer !== undefined && video !== undefined
      && layer.children.includes(video)
    record('#10 the media is mounted INSIDE the layer, not straight on the body',
      inside && run.dom.body.children.length === 1,
      'inside=' + String(inside) + ' bodyChildren=' + String(run.dom.body.children.length))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const video = run.videos()[0]
    record('#11 the source is entry.mediaUrl, and the background loops',
      video !== undefined && video.src === '/appearance-media/media/up-bg' && video.loop === true,
      'src=' + String(video?.src) + ' loop=' + String(video?.loop))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({
        revision: 4,
        slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } },
        options: { background: { surface: 0.4 } },
      }),
    })
    await tick()
    const layer = run.layers()[0]
    const mask = layer?.children?.[0]
    record('#12 the mask follows the surface option that was just read',
      mask !== undefined && String(mask.style.opacity) === '0.4',
      'opacity=' + String(mask?.style?.opacity))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const urls = run.fetchLog.map((row) => row.url)
    const caches = run.fetchLog.map((row) => row.init?.cache)
    record('#13 the configuration and the catalog are read live, and never cached',
      urls.includes('/appearance-media/slots') && urls.includes('/appearance-media/catalog.json')
      && caches.every((cache) => cache === 'no-store'),
      'urls=' + JSON.stringify(urls) + ' caches=' + JSON.stringify(caches))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const slot = run.controller?.state?.().slots?.background
    record('#14 the surface publishes its own facts into the arbitration point\'s state',
      slot !== undefined && slot.videoCount === 1 && slot.hidden === false,
      'slot=' + JSON.stringify(slot))
  }

  /* ---- the release --------------------------------------------------- */

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    // ★ THE SURFACE'S OWN RELEASE. The page being hidden does NOT release
    // any more (it pauses), so the contract's order is read from the release
    // that really tears the surface down.
    run.background.release()
    await tick()
    const verdict = releaseOrder(run.dom.calls)
    record('#15 the release order is pause, clear the source, unbind, disconnect, clear the timer, remove',
      verdict.ok, verdict.detail)
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    run.background.release()
    await tick()
    const left = run.layers().length + run.videos().length + run.styles().length
    const bodyChildren = run.dom.body.children.length
    record('#16 after the release not one of our elements is left on the page',
      left === 0 && bodyChildren === 0,
      'left=' + String(left) + ' bodyChildren=' + String(bodyChildren))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const video = run.videos()[0]
    run.dom.document.visibilityState = 'hidden'
    run.dom.document.hidden = true
    run.dom.document.dispatch('visibilitychange')
    await tick()
    record('#17 a hidden page does NOT take the background off the screen',
      run.videos().length === 1 && run.layers().length === 1 && video !== undefined,
      'videos=' + String(run.videos().length) + ' layers=' + String(run.layers().length))
  }

  /* ---- the yielding -------------------------------------------------- */

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const before = run.videos().length
    run.dom.body.attributes['data-we-wallpaper'] = 'on'
    await run.background.refresh()
    await tick()
    record('#18 the other plugin\'s marker makes this surface withdraw and stop',
      before === 1 && run.videos().length === 0 && run.layers().length === 0,
      'before=' + String(before) + ' videos=' + String(run.videos().length)
      + ' layers=' + String(run.layers().length))
  }

  {
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const reads = run.dom.reads.filter((read) => read === 'body.getAttribute:data-we-wallpaper')
    record('#19 the marker is read, and it is read from the body',
      reads.length > 0, 'reads=' + String(reads.length))
  }

  {
    // ★ No arbitration point ⇒ no surface. Not a second one: none.
    const run = runSandbox({
      withController: false,
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    record('#20 without an arbitration point the surface registers nothing',
      run.background !== undefined && run.background !== null
      && run.background.available === false
      && run.layers().length === 0 && run.videos().length === 0
      && run.warnings.length > 0,
      'available=' + String(run.background?.available)
      + ' layers=' + String(run.layers().length) + ' videos=' + String(run.videos().length)
      + ' warnings=' + String(run.warnings.length))
  }

  /* ---- the negative controls ----------------------------------------- */

  {
    // ★ The observer and the timer swapped: the order assertion MUST fail.
    const broken = mutate(BACKGROUND_TEXT,
      '        // ③ the observer.\n',
      '        // ③ the timer, moved here by the reverse control.\n'
      + '        if (pollTimer !== null) {\n'
      + '          if (typeof globalThis.clearInterval === \'function\') globalThis.clearInterval(pollTimer)\n'
      + '          pollTimer = null\n'
      + '        }\n'
      + '        // ③ the observer.\n',
      'the observer and the timer are swapped')
    const cleared = mutate(broken,
      '        // ④ the timer.\n'
      + '        if (pollTimer !== null) {\n'
      + '          if (typeof globalThis.clearInterval === \'function\') globalThis.clearInterval(pollTimer)\n'
      + '          pollTimer = null\n'
      + '        }\n',
      '        // ④ the timer, moved up by the reverse control.\n',
      'the timer block is removed')
    const run = runSandbox({
      background: cleared,
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    run.background.release()
    await tick()
    const verdict = releaseOrder(run.dom.calls)
    record('#21 REVERSE CONTROL: a release that clears the timer before the observer breaks the order',
      cleared !== BACKGROUND_TEXT && !verdict.ok, verdict.detail)
  }

  {
    // ★ The media element leaves the page in the middle of the release.
    const broken = mutate(BACKGROUND_TEXT,
      '        deferredRemovals.push(element)\n',
      '        removeElement(element)\n',
      'the deferred removal is switched off')
    const run = runSandbox({
      background: broken,
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    run.background.release()
    await tick()
    const verdict = releaseOrder(run.dom.calls)
    record('#22 REVERSE CONTROL: a release that removes the media too early breaks the order',
      broken !== BACKGROUND_TEXT && !verdict.ok, verdict.detail)
  }

  {
    // ★ The adapter stops clearing the source.
    const broken = mutate(RENDERERS_TEXT,
      "        video.removeAttribute('src')\n",
      '        /* the source is not cleared */\n',
      'the adapter stops clearing the source')
    const run = runSandbox({
      renderers: broken,
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    run.background.release()
    await tick()
    const verdict = releaseOrder(run.dom.calls)
    record('#23 REVERSE CONTROL: an adapter that does not clear the source breaks the order',
      broken !== RENDERERS_TEXT && !verdict.ok, verdict.detail)
  }

  {
    // ★ The yielding check never fires.
    // ★ The anchor moved because the check now reads TWO markers; the
    // VERDICT and the OUTPUT LINE are untouched.
    const broken = mutate(BACKGROUND_TEXT,
      "      if (value !== undefined && value !== null && String(value) !== '') return true\n",
      '      if (false) return true\n',
      'the yielding check never fires')
    const run = runSandbox({
      background: broken,
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    run.dom.body.attributes['data-we-wallpaper'] = 'on'
    await run.background.refresh()
    await tick()
    record('#24 REVERSE CONTROL: a yielding check that never fires keeps the layer up',
      broken !== BACKGROUND_TEXT && run.videos().length === 1 && run.layers().length === 1,
      'videos=' + String(run.videos().length) + ' layers=' + String(run.layers().length))
  }

  /* ---- the review round: A1 … A5 ------------------------------------- */

  {
    // ★ A1 — THE FATAL REGRESSION. A material switched BY THE ARBITRATION
    // POINT has to land inside the layer, exactly like the one the surface
    // applied itself. This is the user's real path ("pick another clip"),
    // and it is the path the first version got wrong.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        controller: options.controller,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
        catalog: catalogPayload([entry('up-bg'), entry('up-bg2')]),
      })
      await tick()
      const layer = run.layers()[0]
      // ★ THE USER'S REAL PATH: the arbitration point applies another clip.
      run.controller.apply('background', entry('up-bg2'))
      const video = run.videos()[0]
      return {
        insideLayer: video !== undefined && layer !== undefined && video.parentNode === layer,
        layerUnderBody: layer !== undefined && layer.parentNode === run.dom.body,
        bodyChildren: run.dom.body.children.length,
        positioned: video !== undefined && String(video.style.position) === 'absolute',
        fixedLayer: run.styles().length > 0
          && String(run.styles()[0].textContent).includes('.dsham-bg-layer{position:fixed;'),
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: the surface does not register its host.
    const brokenSource = mutate(BACKGROUND_TEXT,
      'controller.registerHost(SLOT, mediaHost()) === true',
      'false',
      'the host registration is switched off')
    const broken = await scenario({ background: brokenSource })
    const goodOk = good.insideLayer && good.layerUnderBody && good.bodyChildren === 1
      && good.positioned && good.fixedLayer
    const brokenOk = broken.insideLayer && broken.layerUnderBody && broken.bodyChildren === 1
      && broken.positioned && broken.fixedLayer
    record('#25 A1 a material switched BY THE ARBITRATION POINT still lands inside the layer',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ A2 — THE MECHANISM. The arbitration point mounts with the host that
    // is registered for THAT slot. The sandbox has no global host, so a media
    // inside the layer can only have come from the slot's registration.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        controller: options.controller,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
        catalog: catalogPayload([entry('up-bg'), entry('up-bg2')]),
      })
      await tick()
      run.controller.apply('background', entry('up-bg2'))
      const video = run.videos()[0]
      const layer = run.layers()[0]
      return {
        inLayer: video !== undefined && layer !== undefined && layer.children.includes(video),
        bodyChildren: run.dom.body.children.length,
        globalHost: run.sandbox.__DSH_APPEARANCE_HOST__ !== undefined,
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: the arbitration point ignores the registered
    // host — the shape of the bug that was there before.
    const brokenController = mutate(CONTROLLER_TEXT,
      "var registered = typeof slot === 'string' ? slotHosts[slot] : undefined",
      'var registered = undefined',
      'the arbitration point ignores the registered host')
    const broken = await scenario({ controller: brokenController })
    const goodOk = good.inLayer && good.bodyChildren === 1 && good.globalHost === false
    const brokenOk = broken.inLayer && broken.bodyChildren === 1 && broken.globalHost === false
    record('#26 A2 the arbitration point mounts with the host registered for THAT slot',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ A3 — THE RESIDUE. A release takes the layer AND the injected
    // transparent CSS with it: a transparent shell with nothing behind it is
    // a broken interface, not an off switch.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
      })
      await tick()
      // ★ THE ARBITRATION POINT RELEASES IT — not the surface.
      run.controller.release('background')
      await tick()
      return {
        layers: run.layers().length,
        styles: run.styles().length,
        videos: run.videos().length,
        bodyChildren: run.dom.body.children.length,
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: the injected style is not removed.
    const brokenSource = mutate(BACKGROUND_TEXT,
      '    removeElement(styleElement)\n',
      '    /* the style stays */\n',
      'the injected style is not removed')
    const broken = await scenario({ background: brokenSource })
    const goodOk = good.layers === 0 && good.styles === 0 && good.videos === 0 && good.bodyChildren === 0
    const brokenOk = broken.layers === 0 && broken.styles === 0 && broken.videos === 0 && broken.bodyChildren === 0
    record('#27 A3 the release takes the layer AND the transparent CSS with it',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ A4 — THE WORDING. "Nothing to do" and "it failed and the old one
    // stayed" are different answers, and the caller has to be able to tell
    // them apart.
    const run = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    const before = run.videos().length
    // The user picks a material that is not in the library any more.
    run.setPayload(slotsPayload({
      revision: 3,
      slots: { background: { enabled: true, mediaId: 'up-missing', revision: 3 } },
    }))
    const result = await run.background.refresh()
    const kept = run.videos().length
    // An entry whose kind is missing ⇒ there is nothing to do.
    const run2 = runSandbox({
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-nokind', revision: 2 } } }),
      catalog: catalogPayload([{ ...entry('up-nokind'), kind: undefined }]),
    })
    await tick()
    const skipped = run2.background.state().lastResult
    const goodOk = result === 'failed-kept-previous' && before === 1 && kept === 1
      && skipped === 'skipped'
    // ★ THE NEGATIVE CONTROL: the failure is reported as a skip.
    const brokenSource = mutate(BACKGROUND_TEXT,
      "          lastResult = 'failed-kept-previous'\n",
      "          lastResult = 'skipped'\n",
      'the failure is reported as a skip')
    const brokenRun = runSandbox({
      background: brokenSource,
      payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
    })
    await tick()
    brokenRun.setPayload(slotsPayload({
      revision: 3,
      slots: { background: { enabled: true, mediaId: 'up-missing', revision: 3 } },
    }))
    const brokenResult = await brokenRun.background.refresh()
    const brokenOk = brokenResult === 'failed-kept-previous'
    record('#28 A4 an unknown material is a failure, and a missing kind is a skip',
      goodOk && !brokenOk,
      'good=' + JSON.stringify({ result, before, kept, skipped })
      + ' broken=' + JSON.stringify({ brokenResult }))
  }

  {
    // ★ A5 — HIDDEN MEANS PAUSED. The element stays, the source stays, the
    // position stays; coming back continues instead of streaming again.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
      })
      await tick()
      const video = run.videos()[0]
      if (video !== undefined) video.currentTime = 5
      run.dom.document.visibilityState = 'hidden'
      run.dom.document.hidden = true
      run.dom.document.dispatch('visibilitychange')
      await tick()
      const paused = video !== undefined && video.paused === true
      const srcKept = video !== undefined && String(video.src) === '/appearance-media/media/up-bg'
      const stillThere = run.videos().length === 1 && run.layers().length === 1
      run.dom.document.visibilityState = 'visible'
      run.dom.document.hidden = false
      run.dom.document.dispatch('visibilitychange')
      await tick()
      const resumed = video !== undefined && video.paused === false
      const continuous = video !== undefined && video.currentTime === 5
      const image = run.renderers.create(entry('up-i', 'image'), { loop: false, muted: true, volume: 0 })
      const imageAbsent = !('pause' in image) && !('resume' in image)
      return {
        paused, srcKept, stillThere, resumed, continuous, imageAbsent,
        result: paused && srcKept && stillThere && resumed && continuous && imageAbsent,
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: hidden releases the background again.
    const brokenSource = mutate(BACKGROUND_TEXT,
      '        pausedForHidden = pauseMedia()\n',
      '        releaseBackground(false)\n',
      'hidden releases the background')
    const broken = await scenario({ background: brokenSource })
    record('#29 A5 hidden pauses the background, and coming back continues it',
      good.result === true && broken.result === false,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  /* ---- the review round 2: B1 … B4 ------------------------------------- */

  {
    // ★ B1 — ONE VIDEO AT A TIME. A switched material does not pause the old
    // one and leave it on the page: the old element is REMOVED. Pausing is
    // what hiding does (`pauseWhenHidden`), not what switching does — and an
    // element whose source is still attached keeps downloading.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        controller: options.controller,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
        catalog: catalogPayload([entry('up-bg'), entry('up-bg2')]),
      })
      await tick()
      const before = run.videos().length
      // ★ THE USER'S REAL PATH: the arbitration point applies another clip.
      run.controller.apply('background', entry('up-bg2'))
      await tick()
      const videos = run.videos()
      const layer = run.layers()[0]
      return {
        before,
        count: videos.length,
        src: videos.length === 1 ? String(videos[0].src) : '',
        inLayer: videos.length === 1 && layer !== undefined && videos[0].parentNode === layer,
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: the switched material only pauses the old one.
    const brokenSource = mutate(BACKGROUND_TEXT,
      '        if (releasing !== true) {\n          removeElement(element)\n          return\n        }\n',
      '        if (releasing !== true) {\n          try { element.pause() } catch (error) { /* only paused */ }\n          return\n        }\n',
      'a switched material only pauses the old one')
    const broken = await scenario({ background: brokenSource })
    const goodOk = good.before === 1 && good.count === 1 && good.inLayer
      && good.src === '/appearance-media/media/up-bg2'
    const brokenOk = broken.count === 1 && broken.inLayer
    record('#30 B1 a switched material leaves ONE video on the page',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ B2 — THE FATAL ONE. A release takes the layer away, so the next
    // apply has to get the layer back from the surface — and the material
    // has to land INSIDE it. If the surface cannot give a host, the attempt
    // FAILS (`failed-kept-previous`) and the old material stays exactly
    // where it is. It must never fall back to the body: a media element on
    // the body has no positioning and lands below the viewport.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        controller: options.controller,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
        catalog: catalogPayload([entry('up-bg'), entry('up-bg2')]),
      })
      await tick()
      // ★ THE ARBITRATION POINT RELEASES IT: the layer goes away with it.
      run.controller.release('background')
      await tick()
      const layersAfterRelease = run.layers().length
      // ★ AND NOW THE USER PICKS ANOTHER CLIP.
      const result = run.controller.apply('background', entry('up-bg2'))
      await tick()
      const layer = run.layers()[0]
      const video = run.videos()[0]
      return {
        layersAfterRelease,
        result,
        insideLayer: video !== undefined && layer !== undefined && video.parentNode === layer,
        layerUnderBody: layer !== undefined && layer.parentNode === run.dom.body,
        bodyChildren: run.dom.body.children.length,
        count: run.videos().length,
      }
    }
    const good = await scenario()
    // ★ THE FAILURE CASE: the surface cannot give a host. The attempt fails
    // loudly and the OLD material stays exactly where it is.
    const failure = await (async () => {
      const brokenSurface = mutate(BACKGROUND_TEXT,
        '      ensure: function () {\n        if (ensureStyle() === null) return null\n',
        '      ensure: function () {\n'
        + '        if (layerElement !== null) throw new Error(\'这个表面给不出宿主。\')\n'
        + '        if (ensureStyle() === null) return null\n',
        'the surface cannot give a host any more')
      const run = runSandbox({
        background: brokenSurface,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
        catalog: catalogPayload([entry('up-bg'), entry('up-bg2')]),
      })
      await tick()
      const before = run.videos().length
      const result = run.controller.apply('background', entry('up-bg2'))
      await tick()
      const videos = run.videos()
      return {
        result,
        before,
        kept: videos.length === 1 && String(videos[0].src) === '/appearance-media/media/up-bg',
      }
    })()
    // ★ THE NEGATIVE CONTROL: the arbitration point ignores the surface's
    // host and falls back to the body — the shape of the fatal bug.
    const brokenNoSlot = mutate(CONTROLLER_TEXT,
      "var registered = typeof slot === 'string' ? slotHosts[slot] : undefined",
      'var registered = undefined',
      'the arbitration point ignores the registered host')
    const brokenBody = mutate(brokenNoSlot,
      'return ask === true ? null : defaultHost()',
      'return defaultHost()',
      'the arbitration point falls back to the body')
    const broken = await scenario({ controller: brokenBody })
    const goodOk = good.layersAfterRelease === 0 && good.result === 'applied'
      && good.insideLayer && good.layerUnderBody && good.bodyChildren === 1 && good.count === 1
      && failure.result === 'failed-kept-previous' && failure.before === 1 && failure.kept
    const brokenOk = broken.insideLayer && broken.layerUnderBody && broken.bodyChildren === 1
    record('#31 B2 after a release the material is back INSIDE a layer — or it fails loudly',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' failure=' + JSON.stringify(failure)
      + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ B3 — THE YIELDING GOES THROUGH THE SAME RELEASE AS EVERYTHING ELSE.
    // Another wallpaper plugin takes the stage ⇒ our media, our layer and
    // our injected style all go: the stage is handed over clean, otherwise
    // the other plugin's own cleanup fights with what we left behind.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
      })
      await tick()
      const before = run.videos().length
      run.dom.body.attributes['data-we-wallpaper'] = 'on'
      await run.background.refresh()
      await tick()
      return {
        before,
        videos: run.videos().length,
        layers: run.layers().length,
        styles: run.styles().length,
        bodyChildren: run.dom.body.children.length,
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: the yielding does not release anything.
    // ★ THE ANCHOR FOLLOWS THE SOURCE: the call site is `yieldStage()` now
    // (the quiet release), and the control still breaks the very same thing
    // — the yielding. What the assertion proves is unchanged.
    const brokenSource = mutate(BACKGROUND_TEXT,
      '        yieldStage()\n        return null\n',
      '        /* the surface stays */\n        return null\n',
      'the yielding does not release the stage')
    const broken = await scenario({ background: brokenSource })
    const goodOk = good.before === 1 && good.videos === 0 && good.layers === 0
      && good.styles === 0 && good.bodyChildren === 0
    const brokenOk = broken.videos === 0 && broken.layers === 0
      && broken.styles === 0 && broken.bodyChildren === 0
    record('#32 B3 the yielding takes the layer, the style and the media with it',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ B4 — THE HAND-OVER. The arbitration point remembers every slot's
    // expected state. When a slot that was pushed off the stage gets the
    // stage back, the slots that were pushed off come back too — highest
    // priority first (boot > screensaver > background), ONE at a time.
    //
    // ★ AND THE ARBITRATION POINT CAN ANSWER "WHO IS PLAYING":
    // `state().slots[*].playing`.
    const stubSurface = (run, entries) => {
      // ★ A STAND-IN FOR A SURFACE THAT DOES NOT EXIST YET. The boot clip
      // and the screensaver are Task 6 and Task 7; the hand-over belongs to
      // the arbitration point, so the test stands in the two surfaces it
      // needs. Their material goes into a container of their own, so the
      // background's layer is not polluted.
      const container = run.dom.createElement('div')
      container.className = 'dsham-stub-layer'
      return {
        createElement(tag) { return run.dom.createElement(tag) },
        mount(element) { container.appendChild(element) },
        unmount(element) { element.remove() },
        ensure() { return true },
        resolve(mediaId) {
          const found = entries.find((row) => row.id === mediaId)
          return Promise.resolve(found === undefined ? null : found)
        },
      }
    }
    const scenario = async (options = {}) => {
      const entries = [entry('up-bg'), entry('up-bg2'), entry('up-boot'), entry('up-scr')]
      const run = runSandbox({
        background: options.background,
        controller: options.controller,
        payload: slotsPayload({
          revision: 5,
          slots: {
            background: { enabled: true, mediaId: 'up-bg', revision: 2 },
            boot: { enabled: true, mediaId: 'up-boot', revision: 1 },
            screensaver: { enabled: true, mediaId: 'up-scr', revision: 1 },
          },
        }),
        catalog: catalogPayload(entries),
      })
      await tick()
      run.controller.registerHost('boot', stubSurface(run, entries))
      run.controller.registerHost('screensaver', stubSurface(run, entries))
      // ★ THE SCREENSAVER TAKES THE STAGE ⇒ THE BACKGROUND IS PUSHED OFF.
      run.controller.apply('screensaver', entry('up-scr'))
      await tick()
      // ★ AND THE BOOT CLIP TAKES IT ⇒ THE SCREENSAVER IS PUSHED OFF.
      run.controller.apply('boot', entry('up-boot'))
      await tick()
      const pushed = run.controller.state()
      // ★ THE BOOT CLIP IS RELEASED ⇒ THE STAGE IS FREE AGAIN.
      run.controller.release('boot')
      // ★ THE STATE IN THE SAME TICK. The hand-over is ONE step: nothing
      // else may come back with it.
      const immediate = run.controller.state()
      await tick()
      await tick()
      const handedOver = run.controller.state()
      const videosAfter = run.videos().length
      // ★ AND NOW THE SCREENSAVER IS RELEASED ⇒ THE BACKGROUND COMES BACK.
      run.controller.release('screensaver')
      await tick()
      await tick()
      const back = run.controller.state()
      const layer = run.layers()[0]
      const video = run.videos()[0]
      return {
        pushedBackground: pushed.slots.background.playing,
        pushedScreensaver: pushed.slots.screensaver.playing,
        immediateBackground: immediate.slots.background.playing,
        handedScreensaver: handedOver.slots.screensaver.playing,
        handedBackground: handedOver.slots.background.playing,
        videosAfter,
        backBackground: back.slots.background.playing,
        backInLayer: video !== undefined && layer !== undefined && video.parentNode === layer,
        backVideos: run.videos().length,
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL 1: the priority is turned around.
    const brokenPriority = mutate(CONTROLLER_TEXT,
      "  var SLOT_PRIORITY = ['boot', 'screensaver', 'background']",
      "  var SLOT_PRIORITY = ['background', 'screensaver', 'boot']",
      'the priority is turned around')
    const broken1 = await scenario({ controller: brokenPriority })
    // ★ THE NEGATIVE CONTROL 2: the hand-over brings every pushed-off slot
    // back at once instead of one at a time.
    const brokenAll = mutate(CONTROLLER_TEXT,
      '    if (candidates.length === 0) return\n    var slot = candidates[0]\n',
      '    if (candidates.length === 0) return\n    var slot = candidates[0]\n'
      + '    for (var c = 1; c < candidates.length; c += 1) {\n'
      + '      apply(candidates[c], slotEntries[candidates[c]])\n'
      + '    }\n',
      'the hand-over brings every pushed-off slot back at once')
    const broken2 = await scenario({ controller: brokenAll })
    const goodOk = good.pushedBackground === false && good.pushedScreensaver === false
      && good.immediateBackground === false
      && good.handedScreensaver === true && good.handedBackground === false
      && good.videosAfter === 0
      && good.backBackground === true && good.backInLayer === true && good.backVideos === 1
    const broken1Ok = broken1.handedScreensaver === true && broken1.handedBackground === false
      && broken1.immediateBackground === false
      && broken1.videosAfter === 0
      && broken1.backBackground === true && broken1.backInLayer === true && broken1.backVideos === 1
    const broken2Ok = broken2.handedScreensaver === true && broken2.handedBackground === false
      && broken2.immediateBackground === false
      && broken2.videosAfter === 0
      && broken2.backBackground === true && broken2.backInLayer === true && broken2.backVideos === 1
    record('#33 B4 the pushed-off slots come back — highest priority first, one at a time',
      goodOk && !broken1Ok && !broken2Ok,
      'good=' + JSON.stringify(good)
      + ' brokenPriority=' + JSON.stringify(broken1)
      + ' brokenAll=' + JSON.stringify(broken2))
  }

  /* ---- the review round 3: C1 … C4 ------------------------------------- */

  {
    // ★ C1 — THE YIELDING TAKES THE STAGE CLEAN, AND THE EARS STAY.
    //
    // The other wallpaper plugin takes the stage ⇒ the media, the layer and
    // the injected style go, and the interface becomes opaque again. But the
    // WATCHER stays: the observer, the poll and the subscription are what
    // hear that the other plugin leaves the stage again. A yielding that
    // took the ears with it would leave nobody listening — and the
    // background would never come back.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
      })
      await tick()
      const before = run.videos().length
      // ★ THE OTHER PLUGIN TAKES THE STAGE.
      run.dom.body.attributes['data-we-wallpaper'] = 'on'
      await run.background.refresh()
      await tick()
      const calls = run.dom.calls
      return {
        before,
        videos: run.videos().length,
        layers: run.layers().length,
        styles: run.styles().length,
        bodyChildren: run.dom.body.children.length,
        disconnects: calls.filter((call) => call === 'disconnect').length,
        unbindOwn: calls.filter((call) => call.includes('removeEventListener:visibilitychange')).length,
        clearTimers: calls.filter((call) => call === 'clearInterval').length,
        timers: run.dom.intervals.length,
        observers: run.dom.observers.filter((row) => row.observed !== null).length,
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: the yielding takes the watcher with it — the
    // shape of the bug that was there before.
    // ★ THE ANCHOR MOVED, THE MEANING DID NOT: the yielding now says that
    // it is a displacement (`releaseBackground(false, true)`), and the
    // control replaces it with the full release (`releaseBackground(true)`),
    // which is the shape that takes the watcher away. The assertion and its
    // output line are unchanged.
    const brokenSource = mutate(BACKGROUND_TEXT,
      '    releaseBackground(false, true)\n    // ★ THE MATERIAL IS NOT "ON SCREEN" ANY MORE.',
      '    releaseBackground(true)\n    // ★ THE MATERIAL IS NOT "ON SCREEN" ANY MORE.',
      'the yielding takes the watcher with it')
    const broken = await scenario({ background: brokenSource })
    const goodOk = good.before === 1 && good.videos === 0 && good.layers === 0
      && good.styles === 0 && good.bodyChildren === 0
      && good.disconnects === 0 && good.unbindOwn === 0 && good.clearTimers === 0
      && good.timers === 2 && good.observers === 1
    const brokenOk = broken.videos === 0 && broken.layers === 0 && broken.styles === 0
      && broken.bodyChildren === 0 && broken.disconnects === 0 && broken.unbindOwn === 0
      && broken.clearTimers === 0 && broken.timers === 2 && broken.observers === 1
    record('#34 C1 the yielding takes the stage clean — and the watcher stays',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ C2 — THE BACKGROUND COMES BACK BY ITSELF.
    //
    // The other plugin leaves the stage ⇒ the background is back: the media
    // is inside the layer again and it plays. Nobody applies it and nobody
    // reloads the page: the surface hears that the marker is gone, and it
    // asks the arbitration point to put the material back.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
      })
      await tick()
      // ★ THE OTHER PLUGIN TAKES THE STAGE.
      run.dom.body.attributes['data-we-wallpaper'] = 'on'
      await run.background.refresh()
      await tick()
      const yielded = run.videos().length
      // ★ THE OTHER PLUGIN LEAVES THE STAGE. Nobody touches the background:
      // no apply, no reload — only the marker is gone.
      delete run.dom.body.attributes['data-we-wallpaper']
      for (const observer of run.dom.observers) {
        if (observer.observed !== null) observer.trigger()
      }
      await tick()
      await tick()
      await tick()
      const layer = run.layers()[0]
      const video = run.videos()[0]
      return {
        yielded,
        videos: run.videos().length,
        layers: run.layers().length,
        insideLayer: video !== undefined && layer !== undefined && video.parentNode === layer,
        playing: run.controller.state().slots.background.playing,
        src: video === undefined ? '' : String(video.src),
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: the yielding takes the watcher with it — then
    // nobody hears that the other plugin left, and the background stays
    // gone. ★ This is the very bug the round is about.
    // ★ THE ANCHOR MOVED, THE MEANING DID NOT: the yielding now says that
    // it is a displacement (`releaseBackground(false, true)`); the control
    // replaces it with the full release, which takes the watcher away. The
    // assertion and its output line are unchanged.
    const brokenSource = mutate(BACKGROUND_TEXT,
      '    releaseBackground(false, true)\n    // ★ THE MATERIAL IS NOT "ON SCREEN" ANY MORE.',
      '    releaseBackground(true)\n    // ★ THE MATERIAL IS NOT "ON SCREEN" ANY MORE.',
      'the yielding takes the watcher with it')
    const broken = await scenario({ background: brokenSource })
    const goodOk = good.yielded === 0 && good.videos === 1 && good.layers === 1
      && good.insideLayer === true && good.playing === true
      && good.src === '/appearance-media/media/up-bg'
    const brokenOk = broken.yielded === 0 && broken.videos === 1 && broken.layers === 1
      && broken.insideLayer === true && broken.playing === true
      && broken.src === '/appearance-media/media/up-bg'
    record('#35 C2 the background comes back by itself when the stage is free again',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ C3 — THE YIELDING DOES NOT TURN THE SLOT OFF.
    //
    // The user did not turn the background off: the slot stays enabled, with
    // the same material. Only the OTHER plugin is on the stage, and it is
    // going to leave again — so the background has to be able to come back.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        controller: options.controller,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
      })
      await tick()
      const before = run.controller.state().slots.background
      // ★ THE OTHER PLUGIN TAKES THE STAGE.
      run.dom.body.attributes['data-we-wallpaper'] = 'on'
      await run.background.refresh()
      await tick()
      const after = run.controller.state().slots.background
      return {
        beforeEnabled: before.enabled,
        beforeMediaId: before.mediaId,
        afterEnabled: after.enabled,
        afterMediaId: after.mediaId,
        afterPlaying: after.playing,
        videos: run.videos().length,
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: a release that turns the slot off — then the
    // yielding would switch the background off without the user asking.
    // ★ THE ANCHOR MOVED, THE MEANING DID NOT: the yielding now tells the
    // arbitration point that it was DISPLACED (pushed aside), and the
    // control makes that call switch the slot off instead. The assertion and
    // its output line are unchanged.
    const brokenController = mutate(CONTROLLER_TEXT,
      '  function displace(slot) {\n'
      + '    if (typeof slot !== \'string\' || SLOT_NAMES.indexOf(slot) === -1) return\n',
      '  function displace(slot) {\n'
      + '    if (typeof slot !== \'string\' || SLOT_NAMES.indexOf(slot) === -1) return\n'
      + '    if (typeof slot === \'string\') state.slots[slot].enabled = false\n',
      'a release turns the slot off')
    const broken = await scenario({ controller: brokenController })
    const goodOk = good.beforeEnabled === true && good.afterEnabled === true
      && good.beforeMediaId === 'up-bg' && good.afterMediaId === 'up-bg'
      && good.afterPlaying === false && good.videos === 0
    const brokenOk = broken.beforeEnabled === true && broken.afterEnabled === true
      && broken.beforeMediaId === 'up-bg' && broken.afterMediaId === 'up-bg'
      && broken.afterPlaying === false && broken.videos === 0
    record('#36 C3 the yielding does not turn the slot off',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

  {
    // ★ C4 — THE RESTORE IS THE ARBITRATION POINT'S WORK.
    //
    // The material comes back through the arbitration point — the same road
    // every other material takes, and the only road there is — and it is the
    // material the configuration names RIGHT NOW: the user may have picked
    // another clip while the other plugin was on the stage.
    const scenario = async (options = {}) => {
      const run = runSandbox({
        background: options.background,
        controller: options.controller,
        payload: slotsPayload({ slots: { background: { enabled: true, mediaId: 'up-bg', revision: 2 } } }),
        catalog: catalogPayload([entry('up-bg'), entry('up-bg2')]),
      })
      await tick()
      // ★ THE OTHER PLUGIN TAKES THE STAGE.
      run.dom.body.attributes['data-we-wallpaper'] = 'on'
      await run.background.refresh()
      await tick()
      // ★ THE USER PICKS ANOTHER CLIP WHILE THE OTHER PLUGIN IS ON THE STAGE.
      run.setPayload(slotsPayload({
        revision: 3,
        slots: { background: { enabled: true, mediaId: 'up-bg2', revision: 3 } },
      }))
      // ★ AND THE OTHER PLUGIN LEAVES THE STAGE.
      delete run.dom.body.attributes['data-we-wallpaper']
      for (const observer of run.dom.observers) {
        if (observer.observed !== null) observer.trigger()
      }
      await tick()
      await tick()
      await tick()
      const layer = run.layers()[0]
      const video = run.videos()[0]
      const state = run.controller.state()
      return {
        slot: state.slot,
        playing: state.slots.background.playing,
        mediaId: state.mediaId,
        videos: run.videos().length,
        insideLayer: video !== undefined && layer !== undefined && video.parentNode === layer,
        src: video === undefined ? '' : String(video.src),
      }
    }
    const good = await scenario()
    // ★ THE NEGATIVE CONTROL: the surface puts the material back ITSELF,
    // without the arbitration point — then nobody applied it, and the
    // arbitration point's own truth says so.
    const brokenSource = mutate(BACKGROUND_TEXT,
      '    yielding = false\n    // ★ ONE ROAD FOR THE COMEBACK',
      '    yielding = false\n'
      + '    // ★ THE REVERSE CONTROL: THE SURFACE MOUNTS IT ITSELF.\n'
      + '    var doc = globalThis.document\n'
      + '    var video = doc.createElement(\'video\')\n'
      + '    video.src = \'/appearance-media/media/up-bg\'\n'
      + '    var layer = ensureLayer()\n'
      + '    if (layer !== null) layer.appendChild(video)\n'
      + '    return null\n'
      + '    // ★ ONE ROAD FOR THE COMEBACK',
      'the surface mounts the material itself')
    const broken = await scenario({ background: brokenSource })
    const goodOk = good.slot === 'background' && good.playing === true
      && good.mediaId === 'up-bg2' && good.videos === 1 && good.insideLayer === true
      && good.src === '/appearance-media/media/up-bg2'
    const brokenOk = broken.slot === 'background' && broken.playing === true
      && broken.mediaId === 'up-bg2' && broken.videos === 1 && broken.insideLayer === true
      && broken.src === '/appearance-media/media/up-bg2'
    record('#37 C4 the background is put back by the arbitration point — with the material of the moment',
      goodOk && !brokenOk,
      'good=' + JSON.stringify(good) + ' broken=' + JSON.stringify(broken))
  }

} catch (error) {
  record('the suite ran to completion', false, String(error && error.stack ? error.stack : error))
} finally {
  notes.push('the background, the adapters and the arbitration point are evaluated as text in a node:vm context with a fake DOM')
  notes.push('the release order is read item by item out of the action log; the reads are kept in a separate log')
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
