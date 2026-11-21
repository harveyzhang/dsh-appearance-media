#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the SETTINGS CARD's interface.
//
// ★ WHAT THIS SUITE IS, AND WHY IT IS WRITTEN THE WAY IT IS.
//
// The card is a React component that only ever runs inside the Host's browser
// half. Nothing about it can be asserted by reading the source: a control can
// be in the file and not on the screen, and a summary can be rendered and say
// nothing. So this suite MOUNTS THE REAL CLIENT: it loads `src/client.js` in a
// VM with a stub React and a stub `fetch`, registers the real slots through
// the real `apply()`, renders the real `plugins.item` card, and drives it the
// way a person would — clicking the pool row, ticking boxes, pressing 确定.
//
// ★ EVERY CHECK HERE CAN FAIL BECAUSE THE IMPLEMENTATION IS WRONG.
//
//   C1  the `plugins.item` summary view must be a plain STRING — an element
//       there crashes the Host's React and kills the card;
//   C2  every surface folds, and the head carries `aria-expanded` and a
//       one-line summary;
//   C3  every option is TWO lines: the title and a grey line that says what
//       the knob does and which way its number goes;
//   C4  the conditional style pickers appear ONLY while their master switch
//       is on — that is the user's own requirement, and it must not regress;
//   C5  the 「片头素材池」 picker opens, lists the library, survives a material
//       that has been deleted, and writes `{ options: { boot: { pool: […] } } }`;
//   C6  every colour comes from a `--dsw-*` token WITH A LITERAL FALLBACK, no
//       custom property references itself, and nothing writes attributes
//       imperatively.
//
// ★ AND EVERY CHECK HAS A REVERSE CONTROL.
//
// `node tools/verify-client-ui.mjs --negative` mutates a COPY of the client —
// one defect at a time — and requires the suite to go red. A check that cannot
// fail is not a check. The control runs inside this file on purpose: a
// negative control that lives in another file is a control nobody runs.
//
// Usage:
//   node tools/verify-client-ui.mjs              the suite
//   node tools/verify-client-ui.mjs --negative   the reverse controls

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = join(ROOT, 'src', 'client.js')

/** @type {Array<[string, boolean, string]>} */
let checks = []

/**
 * Record one assertion.
 *
 * @param label - what is asserted.
 * @param ok - whether it holds.
 * @param detail - the evidence, printed next to the label.
 */
function record(label, ok, detail = '') {
  checks.push([label, Boolean(ok), detail])
}

/* ══════════════════════════════════════════════════════════════════════════
   THE STUB REACT — enough of it to render the card and drive it.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Build a React stub with a per-component hook store.
 *
 * ★ EVERY COMPONENT GETS ITS OWN HOOK STORE. A single shared array would make
 * two components in one tree share slot 0, and the state of one would appear
 * in the other.
 *
 * @returns {{ React: object, host: object }} the stub and its host.
 */
function createReact() {
  const host = { stores: new Map(), current: null }

  const React = {
    createElement: function (type, props) {
      const p = Object.assign({}, props)
      const rest = Array.prototype.slice.call(arguments, 2)
      if (rest.length === 1) p.children = rest[0]
      else if (rest.length > 1) p.children = rest
      return { type: type, props: p }
    },
    useState: function (initial) {
      const store = host.current
      const i = store.index++
      if (!(i in store.hooks)) {
        store.hooks[i] = typeof initial === 'function' ? initial() : initial
      }
      const set = function (value) {
        store.hooks[i] = typeof value === 'function' ? value(store.hooks[i]) : value
      }
      return [store.hooks[i], set]
    },
    useEffect: function (fn, deps) {
      const store = host.current
      const i = store.index++
      const list = deps === undefined ? [] : deps
      const prev = store.deps[i]
      const changed = prev === undefined
        || prev.length !== list.length
        || list.some(function (d, k) { return d !== prev[k] })
      if (changed) {
        store.deps[i] = list.slice()
        store.effects.push({ index: i, fn: fn })
      }
    },
    useCallback: function (fn) { return fn },
    useRef: function (v) { return { current: v } },
    useMemo: function (fn) { return fn() },
  }
  return { React, host }
}

/**
 * The hook store of one component.
 *
 * @param host - the host.
 * @param fn - the component function.
 * @returns the store.
 */
function storeFor(host, fn) {
  let store = host.stores.get(fn)
  if (store === undefined) {
    store = { hooks: [], deps: [], index: 0, effects: [], cleanups: [] }
    host.stores.set(fn, store)
  }
  return store
}

/**
 * Render one component and run its effects.
 *
 * @param node - the element.
 * @param React - the stub.
 * @param host - the host.
 * @returns the component's output.
 */
function mountComponent(node, React, host) {
  const store = storeFor(host, node.type)
  const previous = host.current
  host.current = store
  store.index = 0
  store.effects = []
  let out
  try {
    out = node.type(node.props)
  } finally {
    host.current = previous
  }
  const pending = store.effects
  store.effects = []
  for (const effect of pending) {
    const cleanup = effect.fn()
    if (typeof cleanup === 'function') store.cleanups[effect.index] = cleanup
  }
  return out
}

/**
 * Render a whole tree, calling every function component on the way.
 *
 * @param node - the tree.
 * @param React - the stub.
 * @param host - the host.
 * @returns the rendered tree.
 */
function deepRender(node, React, host) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) {
    return node.map(function (n) { return deepRender(n, React, host) })
  }
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    return deepRender(mountComponent(node, React, host), React, host)
  }
  const props = Object.assign({}, node.props)
  if (props.children !== undefined) props.children = deepRender(props.children, React, host)
  return { type: node.type, props: props }
}

/* ══════════════════════════════════════════════════════════════════════════
   TREE HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every node of the tree that satisfies a predicate.
 *
 * @param tree - the tree.
 * @param predicate - the test.
 * @returns the matching nodes.
 */
function findAll(tree, predicate) {
  const out = []
  const visit = function (node) {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object') return
    if (predicate(node)) out.push(node)
    if (node.props && node.props.children !== undefined) visit(node.props.children)
  }
  visit(tree)
  return out
}

/**
 * The first node with the given attribute.
 *
 * @param tree - the tree.
 * @param name - the attribute name.
 * @param value - the value, when one is given.
 * @returns the node, or null.
 */
function findByAttr(tree, name, value) {
  const found = findAll(tree, function (node) {
    if (!node.props) return false
    if (!(name in node.props)) return false
    if (value === undefined) return true
    return node.props[name] === value
  })
  return found.length === 0 ? null : found[0]
}

/**
 * The text of a node.
 *
 * @param node - the node.
 * @returns the concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.props ? node.props.children : undefined)
}

/**
 * Click a node.
 *
 * @param node - the node.
 */
function click(node) {
  if (node === null || node === undefined || !node.props || typeof node.props.onClick !== 'function') {
    throw new Error('the node has no click handler')
  }
  node.props.onClick({
    stopPropagation: function () {},
    preventDefault: function () {},
    currentTarget: {},
    target: {},
  })
}

/**
 * Tick or untick a checkbox node.
 *
 * @param node - the node.
 * @param checked - the new state.
 */
function tick(node, checked) {
  if (node === null || node === undefined || !node.props || typeof node.props.onChange !== 'function') {
    throw new Error('the node has no change handler')
  }
  node.props.onChange({ target: { checked: checked }, stopPropagation: function () {} })
}

/**
 * Click a node WHEN THERE IS ONE.
 *
 * ★ A CHECK MUST NOT THROW WHEN A CONTROL IS MISSING. A control that has
 * been taken away has to turn a CHECK red, not the whole suite: a suite that
 * dies on the first missing node proves nothing about the checks after it,
 * and the reverse control then proves only that the suite crashes.
 *
 * @param node - the node.
 * @returns whether it was clicked.
 */
function clickIfPresent(node) {
  if (node === null || node === undefined || !node.props) return false
  if (typeof node.props.onClick !== 'function') return false
  click(node)
  return true
}

/**
 * Call one handler, WHEN THERE IS ONE.
 *
 * @param node - the node.
 * @param name - the handler's name.
 * @param event - the event.
 * @returns whether the handler was called.
 */
function fire(node, name, event) {
  if (node === null || node === undefined || !node.props) return false
  const handler = node.props[name]
  if (typeof handler !== 'function') return false
  handler(event)
  return true
}

/**
 * A fake pointer event, for the self-drawn slider.
 *
 * The slider reads the pointer's position against the element's own box, so
 * the event has to carry both. `setPointerCapture` is a stub: the real one
 * needs a live DOM node, and the slider must work without it.
 *
 * @param x - the pointer's horizontal position, in the element's own pixels.
 * @param width - the element's width.
 * @returns the event.
 */
function pointerEvent(x, width) {
  return {
    clientX: x,
    pointerId: 1,
    currentTarget: {
      getBoundingClientRect: function () {
        return { left: 0, top: 0, width: width, height: 20 }
      },
      setPointerCapture: function () {},
    },
    preventDefault: function () {},
    stopPropagation: function () {},
  }
}

/**
 * A fake key event, for the self-drawn slider.
 *
 * @param key - the key.
 * @returns the event.
 */
function keyEvent(key) {
  return { key: key, preventDefault: function () {}, stopPropagation: function () {} }
}

/**
 * The DIRECT parent of the first node that satisfies a predicate.
 *
 * ★ THE PARENT IS NOT THE SAME AS THE CONTAINER. A group's body holds the
 * option plates AND the material list, so "the element that holds them" is
 * too coarse to say anything about the space BETWEEN two plates; only the
 * direct parent does.
 *
 * @param tree - the tree.
 * @param predicate - the test for the child.
 * @returns the parent node, or null.
 */
function parentOf(tree, predicate) {
  let found = null
  const visit = function (node) {
    if (found !== null) return
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const children = node.props ? node.props.children : undefined
    if (children !== undefined) {
      const list = Array.isArray(children) ? children : [children]
      const hit = list.some(function (child) {
        return child !== null && typeof child === 'object' && predicate(child)
      })
      if (hit) {
        found = node
        return
      }
    }
    visit(children)
  }
  visit(tree)
  return found
}

/* ══════════════════════════════════════════════════════════════════════════
   THE FIXTURE — the catalog and the configuration the Host would answer with.
   ══════════════════════════════════════════════════════════════════════════ */

const CATALOG = {
  revision: 3,
  entries: [
    { id: 'a.mp4', name: '清晨', kind: 'video', bytes: 1024 * 1024, mediaUrl: '/appearance-media/media/a.mp4' },
    { id: 'b.mp4', name: '黄昏', kind: 'video', bytes: 2 * 1024 * 1024, mediaUrl: '/appearance-media/media/b.mp4' },
    { id: 'c.png', name: '静帧', kind: 'image', bytes: 2048, mediaUrl: '/appearance-media/media/c.png' },
  ],
}

/**
 * A fresh configuration.
 * @returns the configuration.
 */
function freshConfig() {
  return {
    revision: 7,
    slots: {
      background: { enabled: true, mediaId: 'a.mp4' },
      boot: { enabled: true, mediaId: 'b.mp4' },
      screensaver: { enabled: true, mediaId: '' },
    },
    options: {
      background: { panel: 0.7, surface: 0.2, muted: true, pauseWhenHidden: false },
      boot: { fadeMs: 2000, holdMs: 10000, muted: false, enterMode: 'tail', source: 'media', pool: [] },
      screensaver: {
        idleMs: 180000, rotateMs: 30000, volume: 0.5, muted: true,
        breakEffect: false, breakStyle: 'particles',
        pointerEffect: false, pointerStyle: 'ripples', hint: true,
      },
    },
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   MOUNTING THE REAL CLIENT
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Load the client in a VM with the stub React and a stub `fetch`.
 *
 * @param path - the client file.
 * @param React - the stub React.
 * @param fetchImpl - the stub fetch.
 * @returns the module's exports.
 */
function loadClient(path, React, fetchImpl) {
  const source = readFileSync(path, 'utf8')
  const module = { exports: {} }
  const sandbox = {
    require: function (name) {
      if (name === 'react') return React
      throw new Error('the client half may only require react, not ' + name)
    },
    exports: module.exports,
    module: module,
    console: { warn: function () {}, error: function () {}, log: function () {} },
    fetch: fetchImpl,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
  }
  const context = createContext(sandbox)
  runInContext(source, context, { filename: path })
  return module.exports
}

/**
 * Mount the client: register its slots, render its card, drive it.
 *
 * @param clientPath - the client file.
 * @returns the app handle.
 */
function mountApp(clientPath) {
  const built = createReact()
  const React = built.React
  const host = built.host

  const state = {
    catalog: CATALOG,
    config: freshConfig(),
    calls: [],
    writes: [],
    // ★ THE OPTIMIZE ROUTE'S ANSWER. It is a FIELD and not a constant, so a
    // check can make the Host refuse — and refuse with its own sentence.
    optimize: {
      ok: true,
      status: 200,
      body: {
        ok: true,
        status: 'done',
        message: '已把 moov 挪到前面：浏览器不用下完整个文件就能出第一帧。',
        bytes: 524288,
        entry: {
          id: 'a.mp4',
          name: '清晨',
          kind: 'video',
          ext: '.mp4',
          bytes: 524288,
          contentHash: 'sha256:stub',
          source: 'upload',
          license: 'user',
          addedAt: 1,
          mediaUrl: '/appearance-media/media/a.mp4',
        },
      },
    },
    optimizeCalls: [],
  }

  const fetchImpl = function (url, options) {
    // ★ THE OPTIMIZE CALL IS COUNTED ON ITS OWN. It goes to a different route
    // and it is a POST with a body, and a body that reached the generic write
    // recorder would be counted as a SLOT WRITE — which is a different thing
    // entirely.
    if (url === '/appearance-media/optimize') {
      const answer = state.optimize
      state.optimizeCalls.push({
        url: url,
        method: (options && options.method) || 'GET',
        body: options && typeof options.body === 'string' ? JSON.parse(options.body) : null,
      })
      return Promise.resolve({
        ok: answer.ok,
        json: function () { return Promise.resolve(answer.body) },
      })
    }
    const call = { url: url, method: (options && options.method) || 'GET', body: null }
    if (options && typeof options.body === 'string') {
      call.body = options.body
      state.writes.push({ url: url, method: call.method, body: JSON.parse(options.body) })
      applyPatch(state.config, JSON.parse(options.body))
    }
    state.calls.push(call)
    if (url === '/appearance-media/catalog.json') {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(state.catalog) } })
    }
    if (url === '/appearance-media/slots') {
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ ok: true, config: state.config, ignored: [] }) },
      })
    }
    return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}) } })
  }

  const registered = []
  const services = {
    slots: {
      inject: function (slot, fn) { return fn() },
      register: function (spec, component) {
        registered.push({ slot: spec.name, spec: spec, component: component })
        return function () {}
      },
    },
    locale: {
      register: function (ns, dict) {
        return function (key) { return dict.zh[key] === undefined ? key : dict.zh[key] }
      },
      bind: function () { return function (key) { return key } },
    },
    configForms: {
      whileServed: function (ns, cb) { return cb() },
      get: function () { return undefined },
    },
  }

  const exports = loadClient(clientPath, React, fetchImpl)
  exports.apply({
    inject: function (names, cb) {
      return cb({
        get: function (name) { return services[name] },
        effect: function (fn) { return fn() },
      })
    },
  })

  const item = registered.filter(function (r) { return r.slot === 'plugins.item' })[0]

  const app = {
    React: React,
    host: host,
    state: state,
    registered: registered,
    item: item,
    tree: null,
    render: function (view) {
      const element = { type: item.component, props: { runtime: React, view: view === undefined ? 'page' : view } }
      app.tree = deepRender(element, React, host)
      return app.tree
    },
    settle: async function () {
      for (let i = 0; i < 8; i++) {
        await new Promise(function (resolve) { setImmediate(resolve) })
      }
    },
  }
  return app
}

/**
 * Apply a write to the fixture configuration, the way the store would.
 *
 * @param config - the configuration.
 * @param patch - the write.
 */
function applyPatch(config, patch) {
  if (typeof patch.slot === 'string') {
    if (config.slots[patch.slot] === undefined) config.slots[patch.slot] = {}
    if (typeof patch.enabled === 'boolean') config.slots[patch.slot].enabled = patch.enabled
    if (typeof patch.mediaId === 'string') config.slots[patch.slot].mediaId = patch.mediaId
  }
  if (patch.options !== undefined && patch.options !== null && typeof patch.options === 'object') {
    for (const group of Object.keys(patch.options)) {
      if (config.options[group] === undefined) config.options[group] = {}
      for (const field of Object.keys(patch.options[group])) {
        config.options[group][field] = patch.options[group][field]
      }
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   SOURCE-LEVEL HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Strip the comments out of a source text.
 *
 * ★ COMMENTS ARE STRIPPED BEFORE EVERY REGEX ASSERTION. A prose sentence that
 * mentions a forbidden call is not a call, and a check that cannot tell the
 * two apart is a check that cries wolf.
 *
 * @param text - the source.
 * @returns the source without its comments.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
}

/**
 * Every `var(--dsw-…)` call in a text, with its parentheses balanced.
 *
 * @param text - the text.
 * @returns the calls.
 */
function eachVarCall(text) {
  const out = []
  const re = /var\(--dsw-/g
  let match
  while ((match = re.exec(text)) !== null) {
    let depth = 0
    let i = match.index + 3
    for (; i < text.length; i++) {
      const ch = text[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
    }
    out.push(text.slice(match.index, i + 1))
  }
  return out
}

/* ══════════════════════════════════════════════════════════════════════════
   THE CHECKS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Run every check against one client file.
 *
 * @param clientPath - the client file.
 * @returns the checks.
 */
async function runChecks(clientPath) {
  checks = []
  const source = stripComments(readFileSync(clientPath, 'utf8'))
  const app = mountApp(clientPath)

  /* ---- the summary view must be a plain string ------------------------- */

  const summary = app.render('summary')
  record('#1 the plugins.item summary view is a plain STRING, not an element',
    typeof summary === 'string' && summary.length > 0,
    'typeof=' + (typeof summary) + ' value=' + JSON.stringify(summary))

  /* ---- the card, mounted ----------------------------------------------- */

  await app.settle()
  // ★ THE PANEL READS ITS CONFIGURATION AND ITS CATALOG WHEN IT MOUNTS, so
  // the FIRST render of the page is the one that STARTS the reads. The tree
  // the checks look at is the one AFTER they answered — otherwise every
  // check would be looking at an empty panel and would pass for the wrong
  // reason.
  app.render('page')
  await app.settle()
  const tree = app.render('page')
  const card = findByAttr(tree, 'data-appearance-card')
  record('#2 the card renders one element carrying data-appearance-card',
    card !== null,
    card === null ? 'not found' : 'found')

  /* ---- the folding groups ---------------------------------------------- */

  const toggles = findAll(tree, function (node) {
    return node.props && node.props['data-group-toggle'] !== undefined
  })
  const surfaces = ['background', 'boot', 'screensaver']
  const everySurfaceFolds = surfaces.every(function (key) {
    return toggles.some(function (node) { return node.props['data-group-toggle'] === key })
  })
  const everyToggleSays = toggles.every(function (node) {
    return node.props['aria-expanded'] === true || node.props['aria-expanded'] === false
  })
  record('#3 every surface renders a folding head whose button carries aria-expanded',
    everySurfaceFolds && everyToggleSays && toggles.length === surfaces.length,
    'toggles=' + toggles.length + ' expanded=' + toggles.map(function (n) { return String(n.props['aria-expanded']) }).join(','))

  const summaries = findAll(tree, function (node) {
    return node.props && node.props['data-group-summary'] !== undefined
  })
  const summariesFilled = summaries.length === surfaces.length && summaries.every(function (node) {
    return textOf(node).trim() !== ''
  })
  record('#4 every folded group carries a one-line summary that says something',
    summariesFilled,
    summaries.map(function (n) { return textOf(n).trim() }).join(' | '))

  const saverSummary = findByAttr(tree, 'data-group-summary', 'screensaver')
  const saverText = saverSummary === null ? '' : textOf(saverSummary)
  record('#5 the screensaver summary reads 「已开启，闲置 3 分钟后出现」',
    saverText.includes('已开启') && saverText.includes('闲置 3 分钟后出现'),
    saverText)

  const collapsed = findByAttr(tree, 'data-group-body', 'screensaver')
  record('#6 a folded group has no body in the tree at all',
    collapsed === null,
    collapsed === null ? 'no body' : 'the body is mounted while the group is closed')

  const saverToggle = findByAttr(tree, 'data-group-toggle', 'screensaver')
  click(saverToggle)
  const opened = app.render('page')
  const openBody = findByAttr(opened, 'data-group-body', 'screensaver')
  const openToggle = findByAttr(opened, 'data-group-toggle', 'screensaver')
  record('#7 clicking the head folds the group open: aria-expanded flips and the body appears',
    openBody !== null && openToggle.props['aria-expanded'] === true,
    'body=' + (openBody !== null) + ' aria-expanded=' + String(openToggle.props['aria-expanded']))

  /* ---- two lines per option -------------------------------------------- */

  const items = findAll(tree, function (node) {
    return node.props && node.props['data-option'] !== undefined
  })
  // ★ THE TWO LINES ARE FOUND BY THEIR OWN MARKERS, NOT BY GUESSING FROM THE
  // TEXT. "The item has more than six characters in it" is not a two-line
  // layout; a title node and a hint node with different, non-empty text is.
  const twoLine = items.every(function (node) {
    const field = node.props['data-option']
    const title = findByAttr(node, 'data-option-title', field)
    const hint = findByAttr(node, 'data-option-hint', field)
    if (title === null || hint === null) return false
    const titleText = textOf(title).trim()
    const hintText = textOf(hint).trim()
    return titleText !== '' && hintText !== '' && titleText !== hintText
  })
  record('#8 every option renders a title AND a second, different line under it',
    items.length > 0 && twoLine,
    'items=' + items.length + ' withBothLines=' + items.filter(function (node) {
      const field = node.props['data-option']
      const title = findByAttr(node, 'data-option-title', field)
      const hint = findByAttr(node, 'data-option-hint', field)
      return title !== null && hint !== null && textOf(title).trim() !== '' && textOf(hint).trim() !== ''
    }).length)

  /* ---- the conditional style pickers ----------------------------------- */

  // ★ THE CHECK LOOKS AT THE OPEN GROUP. The screensaver group starts folded,
  // and a folded group's options are not in the tree at all — so a check that
  // looked at the folded tree would pass whether the condition works or not.
  // A check that cannot fail is not a check.
  const breakStyleOff = findByAttr(opened, 'data-option', 'breakStyle')
  const pointerStyleOff = findByAttr(opened, 'data-option', 'pointerStyle')
  record('#9 the style pickers are hidden while their master switches are off',
    breakStyleOff === null && pointerStyleOff === null,
    'breakStyle=' + (breakStyleOff !== null) + ' pointerStyle=' + (pointerStyleOff !== null))

  app.state.config.options.screensaver.breakEffect = true
  app.state.config.options.screensaver.pointerEffect = true
  const withStyles = app.render('page')
  const breakStyleOn = findByAttr(withStyles, 'data-option', 'breakStyle')
  const pointerStyleOn = findByAttr(withStyles, 'data-option', 'pointerStyle')
  record('#10 the style pickers appear once their master switches are on',
    breakStyleOn !== null && pointerStyleOn !== null,
    'breakStyle=' + (breakStyleOn !== null) + ' pointerStyle=' + (pointerStyleOn !== null))

  const allItems = findAll(withStyles, function (node) {
    return node.props && node.props['data-option'] !== undefined
  })
  const hintsPresent = allItems.every(function (node) {
    const hint = findByAttr(node, 'data-option-hint', node.props['data-option'])
    return hint !== null && textOf(hint).trim() !== ''
  })
  record('#11 every option that is on screen carries a non-empty second line',
    allItems.length >= 15 && hintsPresent,
    'items=' + allItems.length + ' withoutHint=' + allItems.filter(function (node) {
      const hint = findByAttr(node, 'data-option-hint', node.props['data-option'])
      return hint === null || textOf(hint).trim() === ''
    }).length)

  /* ---- the tokens -------------------------------------------------------- */

  const varCalls = eachVarCall(source)
  const fallbacks = varCalls.every(function (call) {
    const inner = call.slice(4, -1)
    const comma = inner.indexOf(',')
    if (comma === -1) return false
    return inner.slice(comma + 1).trim() !== ''
  })
  record('#12 every --dsw-* token carries a literal fallback',
    varCalls.length > 0 && fallbacks,
    'tokens=' + varCalls.length + ' withoutFallback=' + varCalls.filter(function (call) {
      const inner = call.slice(4, -1)
      const comma = inner.indexOf(',')
      return comma === -1 || inner.slice(comma + 1).trim() === ''
    }).length)

  // ★ A DEFINITION MAY BE QUOTED. In an inline style object a custom property
  // is written `'--name': '…'`, and a scan that only knows the bare form
  // would miss the very accident it is looking for.
  const definitions = source.match(/--[a-zA-Z0-9-]+['"]?\s*:/g) || []
  const definedNames = definitions.map(function (def) {
    return def.replace(/['"]?\s*:$/, '')
  })
  const selfReferencing = definedNames.filter(function (name) {
    const re = new RegExp('var\\(\\s*' + name + '\\s*[,)]')
    return re.test(source)
  })
  record('#13 no CSS custom property references itself',
    selfReferencing.length === 0,
    'definitions=' + definitions.length + ' selfReferencing=' + selfReferencing.join(','))

  const hostRedefined = definitions.filter(function (def) { return def.startsWith('--dsw-') })
  record('#14 the file does not redefine a host token',
    hostRedefined.length === 0,
    hostRedefined.join(','))

  const literals = source.match(/'[^'\n]*'/g) || []
  const colourLiterals = literals.filter(function (lit) {
    return /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(lit)
  })
  const hardCoded = colourLiterals.filter(function (lit) {
    if (lit.includes('var(--dsw-')) return false
    // The two scrims: the modal's backdrop and the sheet's shadow. They are
    // not theme colours — a scrim has to darken whatever is behind it.
    // ★ The backdrop is matched by PATTERN, not by one literal: how dark it
    //   needs to be depends on how translucent the layer under it is, and a
    //   whitelist of one exact value would turn every tuning of it into a
    //   failing assertion (which is how it caught itself once).
    if (/^'rgba\(0,\s*0,\s*0,\s*\.\d+\)'$/.test(lit)) return false
    if (lit.includes('rgba(0,0,0,.') && lit.includes('px')) return false
    return true
  })
  record('#15 no colour is hard-coded outside a token fallback',
    hardCoded.length === 0,
    hardCoded.join(' '))

  const imperative = source.match(/\.(setAttribute|removeAttribute|toggleAttribute)\s*\(/g) || []
  record('#16 nothing writes an attribute imperatively',
    imperative.length === 0,
    imperative.join(','))

  /* ---- the pool picker --------------------------------------------------- */

  const poolRow = findByAttr(tree, 'data-pool-open')
  record('#17 the card carries a 「片头素材池」 row',
    poolRow !== null && textOf(poolRow).includes('片头素材池'),
    poolRow === null ? 'no row' : textOf(poolRow).trim())

  const poolCount = findByAttr(tree, 'data-pool-count')
  const poolText = poolCount === null ? '' : textOf(poolCount)
  record('#18 the pool row reads "N 段，已选 M"',
    poolText.includes('3 段，已选 0') && poolText.includes('›'),
    poolText)

  click(poolRow)
  await app.settle()
  const withDialog = app.render('page')
  const dialog = findByAttr(withDialog, 'role', 'dialog')
  record('#19 clicking the pool row opens a dialog',
    dialog !== null && dialog.props['aria-label'] === '片头素材池',
    dialog === null ? 'no dialog' : String(dialog.props['aria-label']))

  const checks3 = findAll(withDialog, function (node) {
    return node.props && node.props['data-pool-check'] !== undefined
  })
  const listed = checks3.map(function (node) { return String(node.props['data-pool-check']) })
  record('#20 the dialog lists every material of the library, each with a checkbox',
    listed.length === CATALOG.entries.length
    && listed.join(',') === CATALOG.entries.map(function (e) { return e.id }).join(','),
    listed.join(','))

  const sheetText = dialog === null ? '' : textOf(dialog)
  record('#21 the dialog says that an empty selection means the whole library',
    sheetText.includes('不选 = 整个素材库随机'),
    sheetText.slice(0, 80))

  const apply = findByAttr(withDialog, 'data-pool-apply')
  const all = findByAttr(withDialog, 'data-pool-all')
  const none = findByAttr(withDialog, 'data-pool-none')
  record('#22 the dialog offers 全选 / 清空 / 确定',
    apply !== null && all !== null && none !== null,
    'apply=' + (apply !== null) + ' all=' + (all !== null) + ' none=' + (none !== null))

  /* ---- a material that has been deleted --------------------------------- */

  app.state.config.options.boot.pool = ['ghost.mp4']
  const beforeMissing = app.render('page')
  click(findByAttr(beforeMissing, 'data-pool-open'))
  await app.settle()
  const missingTree = app.render('page')
  const ghost = findByAttr(missingTree, 'data-pool-missing', 'ghost.mp4')
  const missingDialog = findByAttr(missingTree, 'role', 'dialog')
  const missingText = missingDialog === null ? '' : textOf(missingDialog)
  record('#23 a selected material that is no longer in the library still gets a row, marked 已丢失',
    ghost !== null && missingText.includes('已丢失') && missingText.includes('ghost.mp4'),
    ghost === null
      ? 'no row for the missing material; dialog=' + (missingDialog === null ? 'none' : missingText)
      : missingText)

  /* ---- the write --------------------------------------------------------- */

  app.state.config.options.boot.pool = []
  const cleanTree = app.render('page')
  click(findByAttr(cleanTree, 'data-pool-open'))
  await app.settle()
  const picker = app.render('page')
  const boxA = findByAttr(picker, 'data-pool-check', 'a.mp4')
  const boxC = findByAttr(picker, 'data-pool-check', 'c.png')
  tick(boxA, true)
  tick(boxC, true)
  const picked = app.render('page')
  const ticked = findAll(picked, function (node) {
    return node.props && node.props['data-pool-check'] !== undefined && node.props.checked === true
  }).map(function (node) { return String(node.props['data-pool-check']) })
  record('#24 the picker shows both ticked boxes while the selection is being edited',
    ticked.length === 2 && ticked.indexOf('a.mp4') !== -1 && ticked.indexOf('c.png') !== -1,
    ticked.join(','))

  const writesBefore = app.state.writes.length
  click(findByAttr(picked, 'data-pool-apply'))
  await app.settle()
  const writes = app.state.writes.slice(writesBefore)
  const body = writes.length === 1 ? writes[0].body : null
  record('#25 确定 writes { options: { boot: { pool: [ids] } } } to the slots route',
    writes.length === 1
    && writes[0].url === '/appearance-media/slots'
    && writes[0].method === 'PUT'
    && body !== null
    && JSON.stringify(body) === JSON.stringify({ options: { boot: { pool: ['a.mp4', 'c.png'] } } }),
    JSON.stringify(writes))

  const afterWrite = app.render('page')
  const dialogGone = findByAttr(afterWrite, 'role', 'dialog')
  record('#26 确定 closes the picker',
    dialogGone === null,
    dialogGone === null ? 'closed' : 'still open')

  /* ---- 全选 / 清空 ------------------------------------------------------- */

  const tree2 = app.render('page')
  click(findByAttr(tree2, 'data-pool-open'))
  await app.settle()
  const picker2 = app.render('page')
  const writesBeforeAll = app.state.writes.length
  click(findByAttr(picker2, 'data-pool-all'))
  const allTree = app.render('page')
  const allTicked = findAll(allTree, function (node) {
    return node.props && node.props['data-pool-check'] !== undefined && node.props.checked === true
  }).map(function (node) { return String(node.props['data-pool-check']) })
  record('#27 全选 picks every material of the library and writes nothing yet',
    allTicked.length === CATALOG.entries.length && app.state.writes.length === writesBeforeAll,
    allTicked.join(',') + ' writes=' + String(app.state.writes.length - writesBeforeAll))

  const noneTree = app.render('page')
  click(findByAttr(noneTree, 'data-pool-none'))
  const noneTree2 = app.render('page')
  const noneTicked = findAll(noneTree2, function (node) {
    return node.props && node.props['data-pool-check'] !== undefined && node.props.checked === true
  })
  record('#28 清空 empties the selection and still writes nothing yet',
    noneTicked.length === 0 && app.state.writes.length === writesBeforeAll,
    'ticked=' + String(noneTicked.length) + ' writes=' + String(app.state.writes.length - writesBeforeAll))

  const writesBeforeEmpty = app.state.writes.length
  click(findByAttr(noneTree2, 'data-pool-apply'))
  await app.settle()
  const emptyWrites = app.state.writes.slice(writesBeforeEmpty)
  record('#29 an empty selection is written as an empty list — the whole library',
    emptyWrites.length === 1
    && JSON.stringify(emptyWrites[0].body) === JSON.stringify({ options: { boot: { pool: [] } } }),
    JSON.stringify(emptyWrites))

  /* ---- the ordinary options still write the ordinary way ---------------- */

  const tree3 = app.render('page')
  const enterClick = findByAttr(tree3, 'data-choice', '进入方式=click')
  const writesBeforeEnter = app.state.writes.length
  click(enterClick)
  await app.settle()
  const enterWrites = app.state.writes.slice(writesBeforeEnter)
  record('#30 an ordinary option still writes { options: { boot: { enterMode } } }',
    enterWrites.length === 1
    && JSON.stringify(enterWrites[0].body) === JSON.stringify({ options: { boot: { enterMode: 'click' } } }),
    JSON.stringify(enterWrites))

  const tree4 = app.render('page')
  const backgroundSwitch = findAll(tree4, function (node) {
    return node.props && node.props['data-switch'] === '启用背景'
  })[0]
  const writesBeforeToggle = app.state.writes.length
  tick(backgroundSwitch, false)
  await app.settle()
  const toggleWrites = app.state.writes.slice(writesBeforeToggle)
  record('#31 the surface switches still write { slot, enabled }',
    toggleWrites.length === 1
    && JSON.stringify(toggleWrites[0].body) === JSON.stringify({ slot: 'background', enabled: false }),
    JSON.stringify(toggleWrites))

  /* ---- the registrations -------------------------------------------------- */

  const names = app.registered.map(function (r) { return r.slot }).sort()
  const wanted = ['plugins.bundle.config', 'plugins.detail.section', 'plugins.item', 'settings.section']
  record('#32 the four slots are still registered',
    names.length === wanted.length && names.join(',') === wanted.join(','),
    names.join(','))

  const itemSpec = app.item === null ? null : app.item.spec
  record('#33 the plugins.item registration still carries the namespace and the order',
    itemSpec !== null && itemSpec.id === 'appearance-media' && itemSpec.order === 60,
    itemSpec === null ? 'no registration' : 'id=' + String(itemSpec.id) + ' order=' + String(itemSpec.order))

  /* ---- no stale style key ---------------------------------------------- */

  // ★ A RENAMED STYLE KEY LEAVES `style: undefined` BEHIND, AND A NODE WITH
  // NO STYLE IS NOT AN ERROR — it just loses its padding and its border. So
  // the check is that every style the card hands to React is an OBJECT.
  const styled = findAll(tree, function (node) { return 'style' in node.props })
  const undefinedStyles = styled.filter(function (node) {
    return node.props.style === undefined || node.props.style === null
  })
  record('#34 every style the card renders is a defined object — no stale style key',
    styled.length > 0 && undefinedStyles.length === 0,
    'styled=' + styled.length + ' undefined=' + undefinedStyles.length)

  /* ---- the head: the avatar, the one title, the meta line ---------------- */

  // ★ THE AVATAR IS DRAWN, NOT FETCHED. The slot's registration face
  // publishes no icon field, and this package has no route that serves its
  // own icon, so an <img> pointing at one would be a broken-image glyph in
  // the settings page — the one place a missing file is least forgivable.
  const avatar = findByAttr(tree, 'data-card-avatar')
  const avatarSvg = avatar === null
    ? null
    : findAll(avatar, function (node) { return node.type === 'svg' })[0]
  const avatarStyle = avatar === null || !avatar.props.style ? {} : avatar.props.style
  record('#35 the card head carries a square avatar, and the avatar has a size',
    avatar !== null && avatarSvg !== null
      && avatarStyle.width === '40px' && avatarStyle.height === '40px',
    'avatar=' + (avatar !== null) + ' svg=' + (avatarSvg !== null)
      + ' size=' + String(avatarStyle.width) + 'x' + String(avatarStyle.height))

  const avatarPictures = avatar === null
    ? []
    : findAll(avatar, function (node) {
      return node.type === 'img' && typeof node.props.src === 'string'
    })
  record('#36 the avatar is drawn inline — no picture is fetched for it',
    avatar !== null && avatarPictures.length === 0
      && source.indexOf('appearance-media/icon') === -1,
    'pictures=' + avatarPictures.length
      + ' iconRoute=' + (source.indexOf('appearance-media/icon') !== -1))

  // ★ THE TITLE APPEARS ONCE. The page already prints 「外观媒体」 above the
  // card, so the card may say it once — in its head — and nowhere else. The
  // strip that used to repeat it (「外观媒体 / 版本 0.1.0 / 素材 14 条」, a
  // whole card of its own) is what made the page read as two things.
  const titleNodes = findAll(tree, function (node) {
    return node.props && node.props['data-card-title'] !== undefined
  })
  const cardText = textOf(card)
  const titleOccurrences = cardText.split('外观媒体').length - 1
  record('#37 the card says 「外观媒体」 exactly once — the duplicate title strip is gone',
    titleNodes.length === 1 && titleOccurrences === 1,
    'titleNodes=' + titleNodes.length + ' occurrences=' + titleOccurrences)

  const meta = findByAttr(tree, 'data-card-meta')
  const metaText = meta === null ? '' : textOf(meta)
  const cardRoots = findAll(tree, function (node) {
    return node.props && node.props['data-card'] !== undefined
  })
  record('#38 the version and the library count are ONE small line at the head, not a card of their own',
    meta !== null && metaText.includes('版本 0.1.0') && metaText.includes('素材 3 条')
      && cardRoots.length === 1,
    'meta=' + metaText + ' cards=' + cardRoots.length)

  /* ---- the accent rail on every group card -------------------------------- */

  const groupRoots = findAll(tree, function (node) {
    return node.props && node.props['data-surface'] !== undefined
  })
  const rails = groupRoots.map(function (node) {
    const style = node.props.style || {}
    return {
      key: node.props['data-surface'],
      open: node.props['data-open'] === '1',
      marker: node.props['data-accent-bar'] === 'true',
      image: typeof style.backgroundImage === 'string' ? style.backgroundImage : '',
      size: typeof style.backgroundSize === 'string' ? style.backgroundSize : '',
    }
  })
  const railOk = rails.length === surfaces.length && rails.every(function (rail) {
    return rail.marker
      && rail.image.indexOf('linear-gradient') !== -1
      && rail.image.indexOf('var(--dsw-') !== -1
      && rail.size.indexOf('3px 100%') !== -1
  })
  // ★ THE OPEN GROUP'S RAIL IS THE BLUE ONE. That is the whole point of the
  // mark: one glance says which section the reader is inside.
  const openRailsAreBlue = rails.filter(function (rail) { return rail.open }).every(function (rail) {
    return rail.image.indexOf('brand-primary-new-colorprimary-new-color') !== -1
  })
  record('#39 every group card paints a 3px rail taken from a host token, and the open one is blue',
    railOk && openRailsAreBlue,
    rails.map(function (rail) {
      return rail.key + ':' + (rail.marker ? 'bar' : 'NO-BAR') + ':' + rail.size
        + (rail.open ? ':open' : ':closed')
    }).join(' | '))

  /* ---- one plate per option ---------------------------------------------- */

  const optionNodes = findAll(tree, function (node) {
    return node.props && node.props['data-option'] !== undefined
  })
  const optionPlates = findAll(tree, function (node) {
    return node.props && node.props['data-option-card'] !== undefined
  })
  const plateRounded = optionPlates.every(function (node) {
    const style = node.props.style || {}
    return typeof style.border === 'string' && style.border !== ''
      && parseFloat(style.borderRadius) > 0
      && typeof style.backgroundColor === 'string' && style.backgroundColor !== ''
  })
  record('#40 every option is a rounded plate of its own',
    optionNodes.length > 0 && optionPlates.length === optionNodes.length && plateRounded,
    'options=' + optionNodes.length + ' plates=' + optionPlates.length
      + ' notRounded=' + optionPlates.filter(function (node) {
        const style = node.props.style || {}
        return typeof style.border !== 'string' || style.border === ''
          || !(parseFloat(style.borderRadius) > 0)
      }).length)

  // ★ THE SPACE BETWEEN TWO PLATES. Ten pixels is what lets the eye walk
  // down the list; without it the plates are one wall again.
  const stack = parentOf(tree, function (node) {
    return node.props && node.props['data-option-card'] !== undefined
  })
  const stackGap = stack === null || !stack.props.style ? NaN : parseFloat(stack.props.style.gap)
  record('#41 the option plates are separated by 8–12px of space',
    !Number.isNaN(stackGap) && stackGap >= 8 && stackGap <= 12,
    'gap=' + String(stackGap) + 'px')

  /* ---- the pills report, they do not control ----------------------------- */

  const pills = findAll(tree, function (node) {
    return node.props && node.props['data-overview'] !== undefined
  })
  const pillsWithBox = pills.filter(function (pill) {
    return findAll(pill, function (node) {
      return node.type === 'input' && node.props && node.props.type === 'checkbox'
    }).length > 0
  })
  const pillsWithDot = pills.filter(function (pill) {
    return findByAttr(pill, 'data-overview-dot') !== null
  })
  const masterSwitches = findAll(tree, function (node) {
    return node.props && typeof node.props['data-switch'] === 'string'
      && node.props['data-switch'].indexOf('启用') === 0
  })
  record('#42 the overview pills carry NO checkbox — a dot reports the state instead',
    pills.length === surfaces.length && pillsWithBox.length === 0
      && pillsWithDot.length === surfaces.length
      && masterSwitches.length === surfaces.length,
    'pills=' + pills.length + ' withBox=' + pillsWithBox.length
      + ' withDot=' + pillsWithDot.length + ' masterSwitches=' + masterSwitches.length)

  // ★ THE DOT SAYS ON OR OFF. It is the only mark left on the pill, so it
  // has to carry the truth.
  const onDot = findByAttr(tree, 'data-overview-dot', 'background')
  const onDotStyle = onDot === null || !onDot.props.style ? {} : onDot.props.style
  const dotIsAccent = typeof onDotStyle.backgroundColor === 'string'
    && onDotStyle.backgroundColor.indexOf('brand-primary-new-colorprimary-new-color') !== -1
  app.state.config.slots.background.enabled = false
  const offTree = app.render('page')
  const offDot = findByAttr(offTree, 'data-overview-dot', 'background')
  const offDotStyle = offDot === null || !offDot.props.style ? {} : offDot.props.style
  app.state.config.slots.background.enabled = true
  record('#43 the dot reports whether the surface is on',
    dotIsAccent && offDot !== null && offDot.props['data-on'] === '0'
      && offDotStyle.backgroundColor === 'transparent',
    'on=' + String(onDotStyle.backgroundColor) + ' off=' + String(offDotStyle.backgroundColor)
      + ' data-on=' + String(offDot === null ? null : offDot.props['data-on']))

  /* ---- the master switch stays on the group's own row -------------------- */

  const surfaceLabels = { background: '背景', boot: '片头', screensaver: '屏保' }
  const mastersInGroup = surfaces.map(function (key) {
    const group = findByAttr(tree, 'data-surface', key)
    const found = group === null ? 0 : findAll(group, function (node) {
      return node.props && node.props['data-switch'] === '启用' + surfaceLabels[key]
    }).length
    return key + '=' + found
  })
  record('#44 every surface keeps exactly ONE master switch on its own row',
    mastersInGroup.every(function (entry) { return entry.slice(entry.indexOf('=') + 1) === '1' }),
    mastersInGroup.join(' '))

  /* ---- the head folds the card ------------------------------------------- */

  const head = findByAttr(tree, 'data-card-head')
  const chevron = findByAttr(tree, 'data-card-chevron')
  const headExpanded = head === null ? null : head.props['aria-expanded']
  click(head)
  const folded = app.render('page')
  const foldedHead = findByAttr(folded, 'data-card-head')
  const foldedBody = findByAttr(folded, 'data-card-body')
  click(foldedHead)
  const reopened = app.render('page')
  const reopenedBody = findByAttr(reopened, 'data-card-body')
  record('#45 the head carries a chevron, folds the card, and opens it again',
    chevron !== null && headExpanded === true
      && foldedHead !== null && foldedHead.props['aria-expanded'] === false
      && foldedBody === null && reopenedBody !== null,
    'chevron=' + (chevron !== null) + ' expanded=' + String(headExpanded)
      + ' foldedBody=' + (foldedBody !== null) + ' reopened=' + (reopenedBody !== null))

  /* ---- three surfaces, three layers -------------------------------------- */

  const cardStyle = cardRoots.length === 0 || !cardRoots[0].props.style ? {} : cardRoots[0].props.style
  const backgroundGroup = findByAttr(tree, 'data-surface', 'background')
  const groupStyle = backgroundGroup === null || !backgroundGroup.props.style
    ? {}
    : backgroundGroup.props.style
  const plateStyle = optionPlates.length === 0 || !optionPlates[0].props.style
    ? {}
    : optionPlates[0].props.style
  record('#46 the card, the group and the option sit on three different surfaces',
    typeof cardStyle.backgroundColor === 'string'
      && cardStyle.backgroundColor.indexOf('bg-layer-3') !== -1
      && typeof groupStyle.backgroundColor === 'string'
      && groupStyle.backgroundColor.indexOf('bg-layer-2') !== -1
      && typeof plateStyle.backgroundColor === 'string'
      && plateStyle.backgroundColor.indexOf('color-mix') !== -1,
    'card=' + String(cardStyle.backgroundColor) + ' group=' + String(groupStyle.backgroundColor)
      + ' option=' + String(plateStyle.backgroundColor))

  /* ---- the choices are button cards -------------------------------------- */

  const tiles = findAll(tree, function (node) {
    return node.props && typeof node.props['data-choice'] === 'string'
      && node.props['data-choice'].indexOf('进入方式=') === 0
  })
  const selectedTile = tiles.filter(function (node) {
    return node.props['aria-pressed'] === 'true'
  })[0]
  const tileStyle = tiles.length === 0 || !tiles[0].props.style ? {} : tiles[0].props.style
  const selectedStyle = selectedTile === undefined || !selectedTile.props.style
    ? {}
    : selectedTile.props.style
  const grids = findAll(tree, function (node) {
    return node.props && node.props.style
      && typeof node.props.style.gridTemplateColumns === 'string'
      && node.props.style.gridTemplateColumns.indexOf('auto-fit') !== -1
  })
  const blueFrame = typeof selectedStyle.borderColor === 'string'
    && selectedStyle.borderColor.indexOf('brand-primary-new-colorprimary-new-color') !== -1
  record('#47 the choices are button cards in a grid, and the chosen one has a blue frame',
    tiles.length === 3 && grids.length > 0
      && parseFloat(tileStyle.borderRadius) >= 8 && blueFrame,
    'tiles=' + tiles.length + ' radius=' + String(tileStyle.borderRadius)
      + ' selectedBorder=' + String(selectedStyle.borderColor))

  /* ---- the one number worth reading at a glance -------------------------- */

  const bigValue = findByAttr(tree, 'data-choice-display', '淡入时长')
  const bigText = bigValue === null ? '' : textOf(bigValue).trim()
  record('#48 a choice of numbers prints the chosen one at display size',
    bigValue !== null && bigText !== '' && bigText === '2 秒',
    'display=' + bigText)

  /* ══════════════════════════════════════════════════════════════════════
     ① THE MATERIAL SUMMARY ROW AND THE SINGLE-SELECT PICKER
     ══════════════════════════════════════════════════════════════════════ */

  // ★ THE FLAT LIST IS GONE. Every surface used to print the whole library
  // under itself — three surfaces, fourteen materials, forty-two rows, and a
  // card nobody could reach the bottom of. The card now carries ONE row per
  // surface, and the list is behind a click.
  const lateTree = app.render('page')
  const mediaRows = findAll(lateTree, function (node) {
    return node.props && node.props['data-media-row'] !== undefined
  })
  const mediaRowKeys = mediaRows.map(function (node) { return String(node.props['data-media-row']) })
  const flatRows = findAll(lateTree, function (node) {
    return node.props && node.props['data-media-id'] !== undefined
  })
  record('#49 every surface shows ONE material summary row, and the flat list is gone',
    mediaRows.length === surfaces.length
      && mediaRowKeys.slice().sort().join(',') === 'background,boot,screensaver'
      && flatRows.length === 0,
    'rows=' + mediaRows.length + ' keys=' + mediaRowKeys.join(',') + ' flat=' + flatRows.length)

  const bgRow = findByAttr(lateTree, 'data-media-row', 'background')
  const bgCurrent = findByAttr(lateTree, 'data-media-current', 'background')
  record('#50 the summary row reads 「素材 … 当前：清晨 ›」',
    bgRow !== null && bgCurrent !== null
      && textOf(bgRow).includes('素材')
      && textOf(bgCurrent).includes('当前：清晨')
      && textOf(bgCurrent).includes('›'),
    bgCurrent === null ? 'no row' : textOf(bgCurrent).trim())

  clickIfPresent(bgRow)
  await app.settle()
  const pickerTree = app.render('page')
  const mediaPicker = findByAttr(pickerTree, 'role', 'dialog')
  record('#51 clicking the summary row opens a single-select dialog with the pool picker\'s shell',
    mediaPicker !== null && mediaPicker.props['aria-modal'] === 'true'
      && mediaPicker.props['aria-label'] === '选择素材'
      && findByAttr(pickerTree, 'data-media-dialog') !== null,
    mediaPicker === null ? 'no dialog' : String(mediaPicker.props['aria-label']))

  const radios = findAll(pickerTree, function (node) {
    return node.props && node.props['data-media-radio'] !== undefined
  })
  const radioIds = radios.map(function (node) { return String(node.props['data-media-radio']) })
  record('#52 the dialog lists every material of the library, one radio each',
    radios.length === CATALOG.entries.length
      && radioIds.join(',') === CATALOG.entries.map(function (e) { return e.id }).join(',')
      && radios.every(function (node) { return node.props.type === 'radio' }),
    radioIds.join(',') + ' types=' + radios.map(function (n) { return String(n.props.type) }).join(','))

  const pickerText = mediaPicker === null ? '' : textOf(mediaPicker)
  record('#53 every material carries a kind badge and its size',
    pickerText.includes('视频') && pickerText.includes('图片')
      && pickerText.includes('1.0 MiB') && pickerText.includes('2.0 KiB'),
    pickerText.slice(0, 120))

  const currentBadge = findByAttr(pickerTree, 'data-media-current-badge', 'a.mp4')
  record('#54 the material the surface is using carries a 「当前」 badge',
    currentBadge !== null && textOf(currentBadge).trim() === '当前',
    currentBadge === null ? 'no badge' : textOf(currentBadge).trim())

  // ★ PICK A DIFFERENT MATERIAL AND CONFIRM IT.
  const radioC = findByAttr(pickerTree, 'data-media-radio', 'c.png')
  fire(radioC, 'onChange', { target: { checked: true }, stopPropagation: function () {} })
  const pickedTree = app.render('page')
  const writesBeforeMedia = app.state.writes.length
  clickIfPresent(findByAttr(pickedTree, 'data-media-apply'))
  await app.settle()
  const mediaWrites = app.state.writes.slice(writesBeforeMedia)
  record('#55 确定 writes { slot, mediaId } to the slots route',
    mediaWrites.length === 1
      && mediaWrites[0].url === '/appearance-media/slots'
      && mediaWrites[0].method === 'PUT'
      && JSON.stringify(mediaWrites[0].body) === JSON.stringify({ slot: 'background', mediaId: 'c.png' }),
    JSON.stringify(mediaWrites))

  // ★ CANCEL WRITES NOTHING.
  const rowForCancel = findByAttr(app.render('page'), 'data-media-row', 'background')
  clickIfPresent(rowForCancel)
  await app.settle()
  const cancelTree = app.render('page')
  const writesBeforeCancel = app.state.writes.length
  clickIfPresent(findByAttr(cancelTree, 'data-media-cancel'))
  await app.settle()
  const afterCancel = app.render('page')
  record('#56 取消 closes the dialog and writes nothing',
    findByAttr(afterCancel, 'role', 'dialog') === null
      && app.state.writes.length === writesBeforeCancel,
    'dialog=' + (findByAttr(afterCancel, 'role', 'dialog') !== null)
      + ' writes=' + String(app.state.writes.length - writesBeforeCancel))

  // ★ THE BACKDROP CLOSES IT.
  const rowForBackdrop = findByAttr(app.render('page'), 'data-media-row', 'background')
  clickIfPresent(rowForBackdrop)
  await app.settle()
  const backdropTree = app.render('page')
  clickIfPresent(findByAttr(backdropTree, 'data-media-dialog'))
  await app.settle()
  const afterBackdrop = app.render('page')
  record('#57 clicking the backdrop closes the dialog',
    findByAttr(afterBackdrop, 'role', 'dialog') === null,
    findByAttr(afterBackdrop, 'role', 'dialog') === null ? 'closed' : 'still open')

  // ★ THE PREVIEW IS STILL THERE, AND IT PLAYS IN PLACE.
  const rowForPreview = findByAttr(app.render('page'), 'data-media-row', 'background')
  clickIfPresent(rowForPreview)
  await app.settle()
  const previewTree = app.render('page')
  const previewButton = findByAttr(previewTree, 'data-media-preview', 'a.mp4')
  const videosBefore = findAll(previewTree, function (node) { return node.type === 'video' }).length
  clickIfPresent(previewButton)
  await app.settle()
  const previewingTree = app.render('page')
  const videosAfter = findAll(previewingTree, function (node) { return node.type === 'video' })
  const stopButton = findByAttr(previewingTree, 'data-media-preview', 'a.mp4')
  clickIfPresent(stopButton)
  await app.settle()
  const stoppedTree = app.render('page')
  const videosStopped = findAll(stoppedTree, function (node) { return node.type === 'video' }).length
  record('#58 the picker keeps the 预览 button, and the material plays in place',
    previewButton !== null && videosBefore === 0 && videosAfter.length === 1
      && videosAfter[0].props.src === '/appearance-media/media/a.mp4' && videosStopped === 0,
    'before=' + videosBefore + ' after=' + videosAfter.length + ' stopped=' + videosStopped)

  // ★ A MATERIAL THAT WAS DELETED STILL GETS A ROW.
  app.state.config.slots.background.mediaId = 'ghost.mp4'
  const ghostRow = findByAttr(app.render('page'), 'data-media-row', 'background')
  clickIfPresent(ghostRow)
  await app.settle()
  const ghostTree = app.render('page')
  const ghostEntry = findByAttr(ghostTree, 'data-media-missing', 'ghost.mp4')
  const ghostDialog = findByAttr(ghostTree, 'role', 'dialog')
  const ghostText = ghostDialog === null ? '' : textOf(ghostDialog)
  record('#59 a material that is no longer in the library still gets a row, marked 已丢失',
    ghostEntry !== null && ghostText.includes('已丢失') && ghostText.includes('ghost.mp4'),
    ghostEntry === null ? 'no row for the deleted material' : ghostText.slice(0, 80))

  /* ══════════════════════════════════════════════════════════════════════
     ② THE SELF-DRAWN SLIDER
     ══════════════════════════════════════════════════════════════════════ */

  const sliderTree = app.render('page')
  const sliders = findAll(sliderTree, function (node) {
    return node.props && node.props['data-slider'] !== undefined
  })
  const nativeRanges = findAll(sliderTree, function (node) {
    return node.type === 'input' && node.props && node.props.type === 'range'
  })
  record('#60 the slider is drawn by the card — there is no native range input',
    sliders.length === 3 && nativeRanges.length === 0
      && sliders.every(function (node) {
        return node.props.role === 'slider' && node.props.tabIndex === 0
          && typeof node.props['aria-valuenow'] === 'number'
      }),
    'sliders=' + sliders.length + ' native=' + nativeRanges.length)

  const panelSlider = findByAttr(sliderTree, 'data-slider', '面板不透明度（越小越透）')
  const rail = findByAttr(panelSlider, 'data-slider-rail')
  const fill = findByAttr(panelSlider, 'data-slider-fill')
  const thumb = findByAttr(panelSlider, 'data-slider-thumb')
  const fillStyle = fill === null ? {} : (fill.props.style || {})
  const thumbStyle = thumb === null ? {} : (thumb.props.style || {})
  record('#61 the slider is a track, a rail, a filled part and a thumb — in host tokens',
    panelSlider !== null && rail !== null && fill !== null && thumb !== null
      && fillStyle.width === '57.143%' && thumbStyle.left === '57.143%'
      && String(fillStyle.backgroundColor).indexOf('brand-primary-new-colorprimary-new-color') !== -1,
    'width=' + String(fillStyle.width) + ' left=' + String(thumbStyle.left)
      + ' fill=' + String(fillStyle.backgroundColor))

  // ★ THE MOUSE. Press, move, release — and ONE write, on the release.
  const beforeDrag = app.state.writes.length
  fire(panelSlider, 'onPointerDown', pointerEvent(150, 200))
  const pressedTree = app.render('page')
  const pressedNumber = findByAttr(pressedTree, 'data-slider-number', '面板不透明度（越小越透）')
  const pressedSlider = findByAttr(pressedTree, 'data-slider', '面板不透明度（越小越透）')
  fire(pressedSlider, 'onPointerMove', pointerEvent(150, 200))
  const movedTree = app.render('page')
  const movedSlider = findByAttr(movedTree, 'data-slider', '面板不透明度（越小越透）')
  const writesDuringDrag = app.state.writes.length - beforeDrag
  fire(movedSlider, 'onPointerUp', pointerEvent(150, 200))
  await app.settle()
  const dragWrites = app.state.writes.slice(beforeDrag)
  const dragValue = dragWrites.length === 1 ? dragWrites[0].body.options.background.panel : null
  record('#62 the mouse moves the thumb and writes ONCE, on the release',
    pressedNumber !== null && textOf(pressedNumber).trim() === '0.82'
      && writesDuringDrag === 0 && dragWrites.length === 1 && dragValue === 0.82
      && JSON.stringify(dragWrites[0].body) === JSON.stringify({ options: { background: { panel: 0.82 } } }),
    'during=' + writesDuringDrag + ' writes=' + JSON.stringify(dragWrites))

  // ★ THE KEYBOARD. One step per arrow press.
  const keyTree = app.render('page')
  const keySlider = findByAttr(keyTree, 'data-slider', '面板不透明度（越小越透）')
  const beforeKey = app.state.writes.length
  fire(keySlider, 'onKeyDown', keyEvent('ArrowRight'))
  await app.settle()
  const keyWrites = app.state.writes.slice(beforeKey)
  record('#63 the arrow keys move the value by one step and write it',
    keyWrites.length === 1
      && JSON.stringify(keyWrites[0].body) === JSON.stringify({ options: { background: { panel: 0.84 } } }),
    JSON.stringify(keyWrites))

  // ★ HOME AND END JUMP TO THE TWO ENDS.
  const homeTree = app.render('page')
  const homeSlider = findByAttr(homeTree, 'data-slider', '面板不透明度（越小越透）')
  const beforeHome = app.state.writes.length
  fire(homeSlider, 'onKeyDown', keyEvent('Home'))
  await app.settle()
  const homeWrites = app.state.writes.slice(beforeHome)
  const endTree = app.render('page')
  const endSlider = findByAttr(endTree, 'data-slider', '面板不透明度（越小越透）')
  const beforeEnd = app.state.writes.length
  fire(endSlider, 'onKeyDown', keyEvent('End'))
  await app.settle()
  const endWrites = app.state.writes.slice(beforeEnd)
  record('#64 Home and End jump to the two ends of the range',
    homeWrites.length === 1 && endWrites.length === 1
      && homeWrites[0].body.options.background.panel === 0.3
      && endWrites[0].body.options.background.panel === 1,
    JSON.stringify(homeWrites) + ' | ' + JSON.stringify(endWrites))

  const numberTree = app.render('page')
  const numberNode = findByAttr(numberTree, 'data-slider-number', '面板不透明度（越小越透）')
  record('#65 the slider prints the value it stands for',
    numberNode !== null && textOf(numberNode).trim() === '1',
    numberNode === null ? 'no number' : textOf(numberNode).trim())

  /* ══════════════════════════════════════════════════════════════════════
     ③ THE OPTIMIZE BUTTON
     ══════════════════════════════════════════════════════════════════════ */

  const optRow = findByAttr(app.render('page'), 'data-media-row', 'background')
  clickIfPresent(optRow)
  await app.settle()
  const optTree = app.render('page')
  const optimizeButtons = findAll(optTree, function (node) {
    return node.props && node.props['data-media-optimize'] !== undefined
  })
  record('#66 every material in the picker carries an 优化 button',
    optimizeButtons.length === CATALOG.entries.length,
    'buttons=' + String(optimizeButtons.length))

  // ★ THE CALL. { mediaId } and nothing else, to the optimize route.
  const beforeOptimize = app.state.optimizeCalls.length
  clickIfPresent(findByAttr(optTree, 'data-media-optimize', 'a.mp4'))
  await app.settle()
  const optCalls = app.state.optimizeCalls.slice(beforeOptimize)
  const doneTree = app.render('page')
  const doneStatus = findByAttr(doneTree, 'data-optimize-status')
  const doneText = doneStatus === null ? '' : textOf(doneStatus)
  const doneDialog = findByAttr(doneTree, 'role', 'dialog')
  const donePickerText = doneDialog === null ? '' : textOf(doneDialog)
  record('#67 优化 posts { mediaId } to the optimize route, and the row shows the size the file now has',
    optCalls.length === 1
      && optCalls[0].url === '/appearance-media/optimize'
      && optCalls[0].method === 'POST'
      && JSON.stringify(optCalls[0].body) === JSON.stringify({ mediaId: 'a.mp4' })
      && doneStatus !== null && doneText.indexOf('已把 moov 挪到前面') !== -1
      && donePickerText.indexOf('512.0 KiB') !== -1
      && donePickerText.indexOf('1.0 MiB') === -1,
    JSON.stringify(optCalls) + ' status=' + doneText + ' picker=' + donePickerText.slice(0, 120))

  // ★ A REFUSAL SHOWS THE HOST'S OWN SENTENCE.
  app.state.optimize = {
    ok: false,
    status: 400,
    body: {
      ok: false,
      code: 'E_UNSUPPORTED',
      error: '这条素材没法优化，没有动它。只有 mp4 能优化。',
    },
  }
  const failTree = app.render('page')
  clickIfPresent(findByAttr(failTree, 'data-media-optimize', 'a.mp4'))
  await app.settle()
  const failAfter = app.render('page')
  const failStatus = findByAttr(failAfter, 'data-optimize-status')
  const failText = failStatus === null ? '' : textOf(failStatus)
  record('#68 a refusal shows the host\'s own sentence, not a generic one',
    failStatus !== null && failStatus.props['data-optimize-status'] === 'error'
      && failText.indexOf('这条素材没法优化，没有动它。只有 mp4 能优化。') !== -1,
    failText)

  // ★ 「已经是 faststart 了」 IS WHAT THE CARD SAYS WHEN THERE WAS NOTHING TO DO.
  app.state.optimize = {
    ok: true,
    status: 200,
    body: {
      ok: true,
      status: 'already',
      message: '已经是 faststart 了，不用优化。',
      entry: {
        id: 'b.mp4',
        name: '黄昏',
        kind: 'video',
        ext: '.mp4',
        bytes: 2097152,
        contentHash: 'sha256:stub2',
        source: 'library',
        license: 'unknown',
        addedAt: 2,
        mediaUrl: '/appearance-media/media/b.mp4',
      },
    },
  }
  const alreadyTree = app.render('page')
  clickIfPresent(findByAttr(alreadyTree, 'data-media-optimize', 'b.mp4'))
  await app.settle()
  const alreadyAfter = app.render('page')
  const alreadyStatus = findByAttr(alreadyAfter, 'data-optimize-status')
  const alreadyText = alreadyStatus === null ? '' : textOf(alreadyStatus)
  record('#69 「已经是 faststart 了」 is what the card says when there was nothing to do',
    alreadyStatus !== null && alreadyStatus.props['data-optimize-status'] === 'already'
      && alreadyText.indexOf('已经是 faststart 了，不用优化。') !== -1,
    alreadyText)

  return checks
}

/* ══════════════════════════════════════════════════════════════════════════
   THE REVERSE CONTROLS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The defects, one at a time.
 *
 * ★ EVERY CONTROL IS A REAL DEFECT THAT WOULD SHIP. A control that breaks
 * something nobody would ever write proves nothing about the suite.
 */
const CONTROLS = [
  {
    label: 'the summary view returns an element instead of a string',
    from: "  return '背景、片头与屏保的素材与选项'",
    to: "  return h('span', null, '背景、片头与屏保的素材与选项')",
  },
  {
    label: 'a host token loses its literal fallback',
    from: "label: 'var(--dsw-alias-label-primary, inherit)'",
    to: "label: 'var(--dsw-alias-label-primary)'",
  },
  {
    label: 'a colour is hard-coded instead of taken from a token',
    from: "  itemTitle: { fontSize: '12.5px', fontWeight: 600, color: C.label, display: 'block' },",
    to: "  itemTitle: { fontSize: '12.5px', fontWeight: 600, color: '#ff0000', display: 'block' },",
  },
  {
    label: 'a custom property is defined in terms of itself',
    // ★ THE ANCHOR MOVED, THE DEFECT DID NOT. The style key this control
    // used to hang on was renamed when the options became plates of their
    // own; the injected defect — a custom property whose value references
    // itself — is the same one, and it still has to turn check #13 red.
    from: '  optionCard: {',
    to: "  optionCard: { '--dsh-panels': 'var(--dsh-panels)',",
  },
  {
    label: 'the conditional style picker ignores its master switch',
    from: '    return optionValue(config, surface.key, spec.when.field) === spec.when.equals',
    to: '    return true',
  },
  {
    label: 'the option hint (the grey second line) is gone',
    from: ", hint: '界面面板有多透明：0.3 最透，1 完全不透明' }",
    to: ' }',
  },
  {
    label: 'the group head stops reporting its state',
    from: "  const summary = surfaceSummary(surface, config, props.entries)",
    to: "  const summary = ''",
  },
  {
    label: 'the group head stops folding',
    from: "        'aria-expanded': open,",
    to: "        'aria-expanded': false,",
  },
  {
    label: 'the pool picker drops the materials that have been deleted',
    from: '  const missing = draft.filter(function (id) { return known[id] !== true })',
    to: '  const missing = []',
  },
  {
    label: 'the picker stops saying that an empty selection is the whole library',
    from: "      h('div', { style: S.sheetNote }, '不选 = 整个素材库随机。勾选后，片头只从选中的素材里挑。'),",
    to: "      h('div', { style: S.sheetNote }, '素材列表'),",
  },
  {
    label: 'the pool write sends a string instead of a list of ids',
    from: "    setOption('boot', 'pool', ids)",
    to: "    setOption('boot', 'pool', ids.join(','))",
  },
  {
    label: 'the pool write clobbers the other boot options',
    from: "    setOption('boot', 'pool', ids)",
    to: "    setOption('boot', 'pool', ids)\n    setOption('boot', 'enterMode', 'click')",
  },
  {
    label: '全选 selects nothing',
    from: "    setDraft(entries.map(function (entry) { return entry.id }))",
    to: '    setDraft([])',
  },
  {
    label: 'the pool row stops counting',
    from: "      String(props.total) + ' 段，已选 ' + String(props.selected) + ' ›'))",
    to: "      String(props.total) + ' 段'))",
  },
  {
    label: 'an attribute is written imperatively',
    from: "  return h('div', { style: S.panel, 'data-appearance-card': 'true' },",
    to: "  return h('div', { ref: function (node) { if (node) node.setAttribute('data-x', '1') }, style: S.panel, 'data-appearance-card': 'true' },",
  },
  {
    label: 'the plugins.item registration loses its id',
    from: "              id: SETTINGS_NAMESPACE,\n              order: 60,\n              label: function () { return t('title') },\n              locale: LOCALE_NAMESPACE,",
    to: "              id: 'appearance',\n              order: 60,\n              label: function () { return t('title') },\n              locale: LOCALE_NAMESPACE,",
  },

  /* ---- the controls for the checks added with the card's new head -------- */

  {
    label: 'the card head loses its avatar',
    from: '        CardAvatar(),',
    to: '        null,',
  },
  {
    label: 'the avatar loses its size',
    from: "    flex: 'none', width: '40px', height: '40px', borderRadius: '11px',",
    to: "    flex: 'none', borderRadius: '11px',",
  },
  {
    label: 'the card prints its title twice',
    from: "          h('span', { style: S.cardTitle, 'data-card-title': 'true' }, '外观媒体'),",
    to: "          h('span', { style: S.cardTitle, 'data-card-title': 'true' }, '外观媒体'),\n          h('span', { style: S.cardTitle, 'data-card-title': 'true' }, '外观媒体'),",
  },
  {
    label: 'the version and the library count go back to a card of their own',
    from: "        h('span', { style: S.cardMeta, 'data-card-meta': 'true' },\n          busy ? '写入中…' : ('版本 ' + PLUGIN_VERSION + ' · 素材 ' + String(entries.length) + ' 条')),",
    to: '        null,',
  },
  {
    label: 'the accent rail loses its marker',
    from: "    'data-accent-bar': 'true',",
    to: "    'data-accent-rail': 'true',",
  },
  {
    label: 'the accent rail is painted across the whole card instead of 3px',
    from: "    backgroundSize: '3px 100%',",
    to: "    backgroundSize: '100% 100%',",
  },
  {
    label: 'the accent rail is hard-coded instead of taken from a token',
    from: "    backgroundImage: 'linear-gradient(180deg, ' + C.borderStrong + ', ' + C.borderSoft + ')',",
    to: "    backgroundImage: 'linear-gradient(180deg, #ff0000, #00ff00)',",
  },
  {
    label: 'the option plates lose their corners',
    from: "    borderRadius: '10px',\n    backgroundColor: C.tile,",
    to: "    borderRadius: '0px',\n    backgroundColor: C.tile,",
  },
  {
    label: 'the options lose the plate of their own',
    from: ", 'data-option-card': 'true'",
    to: '',
  },
  {
    label: 'the option plates are stacked with no space between them',
    from: "  itemStack: { display: 'flex', flexDirection: 'column', gap: '10px' },",
    to: "  itemStack: { display: 'flex', flexDirection: 'column', gap: '0px' },",
  },
  {
    label: 'a pill gets a checkbox back',
    from: "      h('span', {\n        style: enabled ? { ...S.dot, ...S.dotOn } : { ...S.dot, ...S.dotOff },",
    to: "      SwitchControl({\n        label: '启用' + surface.label,\n        checked: enabled,\n        onChange: function () {},\n      }),\n      h('span', {\n        style: enabled ? { ...S.dot, ...S.dotOn } : { ...S.dot, ...S.dotOff },",
  },
  {
    label: 'the pill loses its dot',
    from: "        'data-overview-dot': surface.key,",
    to: "        'data-overview-dot-removed': surface.key,",
  },
  {
    label: 'the dot always says the surface is on',
    from: "        'data-on': enabled ? '1' : '0',",
    to: "        'data-on': '1',",
  },
  {
    label: "the group's master switch stops being the surface's own switch",
    from: "          label: '启用' + surface.label,\n          checked: enabled,\n          onChange: function (next) { props.onToggle(surface.key, next) },",
    to: "          label: (surface.key === 'boot' ? '总开关' : '启用') + surface.label,\n          checked: enabled,\n          onChange: function (next) { props.onToggle(surface.key, next) },",
  },
  {
    label: 'the head stops folding the card',
    from: "        'aria-expanded': cardOpen,",
    to: "        'aria-expanded': true,",
  },
  {
    label: 'the group and the card share one surface',
    from: "  group: {\n    border: '1px solid ' + C.border,\n    borderRadius: '12px',\n    backgroundColor: C.layerRaised,",
    to: "  group: {\n    border: '1px solid ' + C.border,\n    borderRadius: '12px',\n    backgroundColor: C.layerHigh,",
  },
  {
    label: 'the choices stop being a grid of cards',
    from: "    gridTemplateColumns: 'repeat(auto-fit, minmax(76px, 1fr))',",
    to: "    gridTemplateColumns: 'none',",
  },
  {
    label: 'the chosen choice loses its blue frame',
    from: "  choiceOn: {\n    borderColor: C.accent,",
    to: "  choiceOn: {\n    borderColor: C.border,",
  },
  {
    label: 'the big value disappears',
    from: "  const big = numeric && chosen !== undefined ? String(chosen[1]) : null",
    to: '  const big = null',
  },

  /* ---- the controls for the material picker, the slider and the optimize -- */

  {
    label: 'the material summary row is gone',
    from: '        MediaSummaryRow({',
    to: '        null && MediaSummaryRow({',
  },
  {
    label: 'the summary row loses its chevron',
    from: "      '当前：' + name + (missing ? '（已丢失）' : '') + ' ›'))",
    to: "      '当前：' + name + (missing ? '（已丢失）' : '') + ''))",
  },
  {
    label: 'the picker does not open',
    from: '    setMediaOpen(true)',
    to: '    setMediaOpen(false)',
  },
  {
    label: 'the picker lists only one material',
    from: '  const known = Object.create(null)\n  for (const entry of entries) known[entry.id] = true\n  const rows = []\n  for (const entry of entries) {',
    to: '  const known = Object.create(null)\n  for (const entry of entries) known[entry.id] = true\n  const rows = []\n  for (const entry of entries.slice(0, 1)) {',
  },
  {
    label: 'the current material loses its 「当前」 badge',
    from: "          ? h('span', { style: S.badge, 'data-media-current-badge': entry.id }, '当前')",
    to: '          ? null',
  },
  {
    label: 'the picker writes the media id without the slot',
    from: '    write({ slot: key, mediaId: mediaId })',
    to: '    write({ mediaId: mediaId })',
  },
  {
    label: '取消 writes anyway',
    from: '  const closeMedia = function () {\n    setMediaOpen(false)',
    to: "  const closeMedia = function () {\n    write({ slot: 'background', mediaId: 'a.mp4' })\n    setMediaOpen(false)",
  },
  {
    label: 'the backdrop does not close the dialog',
    from: "    'data-media-dialog': 'true',\n    onClick: props.onCancel,",
    to: "    'data-media-dialog': 'true',",
  },
  {
    label: 'the preview button is gone',
    from: "          'data-media-preview': entry.id,",
    to: "          'data-media-preview-gone': entry.id,",
  },
  {
    label: 'the deleted material row is gone',
    from: "  if (currentId !== null && currentId !== undefined && currentId !== '' && known[currentId] !== true) {",
    to: '  if (false) {',
  },
  {
    label: 'the slider stops being a slider',
    from: "      role: 'slider',\n      tabIndex: 0,",
    to: '      tabIndex: 0,',
  },
  {
    label: 'the filled part of the slider is a fraction instead of a percentage',
    from: '  const percent = String(Math.round(ratio * 100000) / 1000)',
    to: '  const percent = String(Math.round(ratio * 1000) / 1000)',
  },
  {
    label: 'the slider loses its rail',
    from: "      h('div', { style: S.sliderRail, 'data-slider-rail': 'true' },",
    to: "      h('div', { style: S.sliderRail, 'data-slider-rail-gone': 'true' },",
  },
  {
    label: 'the mouse does not move the thumb',
    from: '    setDragging(true)\n    setDraft(next)\n  }',
    to: '    setDragging(true)\n  }',
  },
  {
    label: 'the arrow keys do nothing',
    from: "    if (key === 'ArrowRight' || key === 'ArrowUp') next = snapNumber(value + step, min, max, step)",
    to: "    if (key === 'ArrowRight' || key === 'ArrowUp') next = null",
  },
  {
    label: 'Home and End do nothing',
    from: "    else if (key === 'Home') next = min",
    to: "    else if (key === 'Home') next = null",
  },
  {
    label: 'the slider stops printing its number',
    from: "h('span', { style: S.value, 'data-slider-number': props.label }, String(shown))",
    to: "h('span', { style: S.value, 'data-slider-number': props.label }, '')",
  },
  {
    label: 'the 优化 button is gone',
    from: "          'data-media-optimize': entry.id,",
    to: "          'data-media-optimize-gone': entry.id,",
  },
  {
    label: 'the optimize call sends no media id',
    from: '      body: JSON.stringify({ mediaId: id }),',
    to: '      body: JSON.stringify({ id: id }),',
  },
  {
    label: 'the optimize result does not reach the row',
    from: '                return item.id === id ? Object.assign({}, item, updated) : item',
    to: '                return item',
  },
  {
    label: 'the refusal is swallowed',
    from: "          const why = body !== null && body !== undefined && typeof body.error === 'string' && body.error !== ''\n            ? body.error\n            : '宿主没有说明原因。'",
    to: "          const why = '宿主没有说明原因。'",
  },
  {
    label: '「已经是 faststart 了」 is never shown',
    from: "          state: body.status === 'already' ? 'already' : 'done',",
    to: "          state: 'done',",
  },
]

/**
 * Run the reverse controls.
 *
 * @returns the number of problems.
 */
async function runNegative() {
  const original = readFileSync(CLIENT, 'utf8')
  const scratch = mkdtempSync(join(tmpdir(), 'dsham-client-ui-'))
  let problems = 0
  console.log('════ 反向对照（改坏的副本 ⇒ 断言必须变红）════')
  for (const control of CONTROLS) {
    const index = original.indexOf(control.from)
    if (index === -1) {
      console.log('FAIL  the anchor for "' + control.label + '" is not in the source any more')
      problems += 1
      continue
    }
    const mutated = original.slice(0, index) + control.to + original.slice(index + control.from.length)
    const copy = join(scratch, 'client-' + String(CONTROLS.indexOf(control)) + '.js')
    writeFileSync(copy, mutated, 'utf8')
    let failed = []
    try {
      const run = await runChecks(copy)
      failed = run.filter(function (entry) { return entry[1] === false }).map(function (entry) { return entry[0] })
    } catch (error) {
      failed = ['the suite threw: ' + String(error && error.message ? error.message : error)]
    }
    const turnedRed = failed.length > 0
    if (!turnedRed) problems += 1
    console.log((turnedRed ? 'PASS  ' : 'FAIL  ') + control.label + '  — red=' + String(failed.length))
    for (const label of failed.slice(0, 4)) console.log('        FAIL ' + label)
  }
  rmSync(scratch, { recursive: true, force: true })
  console.log('════ ' + String(CONTROLS.length) + ' control(s), ' + String(problems) + ' problem(s) ════')
  return problems
}

/* ══════════════════════════════════════════════════════════════════════════
   THE REPORT
   ══════════════════════════════════════════════════════════════════════════ */

const negative = process.argv.includes('--negative')
let exitCode = 0

if (negative) {
  const problems = await runNegative()
  exitCode = problems === 0 ? 0 : 1
} else {
  await runChecks(CLIENT)
  for (const [label, ok, detail] of checks) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === '' ? '' : '  — ' + detail))
  }
  const failed = checks.filter(function (entry) { return entry[1] === false })
  console.log('')
  console.log(checks.length + ' check(s), ' + failed.length + ' failed')
  if (failed.length > 0) {
    exitCode = 1
    for (const [label, , detail] of failed) {
      console.log('failed: ' + label + (detail === '' ? '' : '  — ' + detail))
    }
  }
}

process.exit(exitCode)
