// dsh-appearance-media — the boot screen surface. INJECTED SIDE.
//
// ★ THIS FILE IS SCRIPT TEXT, NOT A MODULE.
//
// The Host half reads this file and pushes it into the page as ONE inline
// `kind:'script'` row (see `index.js`). It runs in <head>, before the shell
// bundle and before the client half exists. ⇒ NO `require`, NO `import`, NO
// `export`, NO script-tag closer, NO HTML comment opener.
//
// ★ PORTED FROM `dsh-boot-animation` (MIT).
//
//   Copyright (c) 2026 dsh-boot-animation contributors
//
// The MECHANISMS below are that plugin's; the DATA MODEL is ours:
//
//   * the overlay is built by hand — no React, no shell module table — because
//     it has to own the viewport BEFORE the application exists;
//   * `ENDLESS_MS` bounds a material whose length cannot be known;
//   * the hold budget tells the user the start is slow, and gives them a way
//     out;
//   * the material's own end is the hand-over signal;
//   * the material library is fetched with a BOUNDED wait: a library that never
//     answers must not hold the viewport.
//
// ★ WHAT DID NOT COME WITH IT:
//
//   * its configuration snapshot (`__DSH_BOOT_ANIM_CFG__`) — ours is read live
//     from the Host's own route, every time;
//   * its clip pools — ours is the material library (`/appearance-media/…`);
//   * its progress observation (`--dsh-boot-arc`) — ours waits for the Host's
//     own readiness signal instead;
//   * its materials — they are not ours to ship, and this package carries none.
//
// ★ THE POOL IS A SUBSET OF THE LIBRARY, AND THE FALLBACKS ARE INSIDE IT.
//
// Upstream, a pool is a FOLDER of clips the user picked. Ours is a list of
// material ids inside the one library: the pool narrows what the random pick
// may choose, and the narrowing happens where the CANDIDATES are resolved —
// so the fallbacks are inside the pool as well. A material the user did not
// put in the pool is never played, not even as the replacement for one that
// cannot be played.
//
// An empty pool is the whole library, and a pool whose materials are all gone
// is the whole library too.
//
// ★ THE MEDIA IS PLAYED BY THE ARBITRATION POINT.
//
// This surface owns the overlay, the layer and the lifetime. The media is
// played through `controller.apply(SLOT, entry)`: the arbitration point owns the
// element, the state and the race handling. Two copies of "what is playing"
// would drift.
//
// ★ THE ARBITRATION POINT IS LOOKED UP, NEVER CREATED.
//
// There is exactly one arbitration point in this build, and it is published by
// `src/controller.js` as `globalThis.__DSH_APPEARANCE_CONTROLLER__`. This
// surface READS that global and validates it exactly the way the client half
// validates it (`state`, `on`, `apply`, `release` must all be functions). It
// never assigns to it. No arbitration point ⇒ no surface: the surface warns
// once and does nothing.
//
// ★ THE HOST IS THE SURFACE'S, AND IT CAN ASK FOR ITS LAYER BACK.
//
// The registered host carries an `ensure()` ("make sure your layer is there")
// and a `resolve()` ("turn this media id into the catalog entry that carries
// the URL"). The arbitration point asks for both. ⇒ the layer is built in
// exactly one place (here);
// ⇒ if the layer cannot be built, the attempt FAILS and the old material
//   stays. The arbitration point never falls back to the body — a media element
//   on the body has no positioning and lands below the viewport.
//
// ★ THE CONFIGURATION IS READ LIVE, NEVER BAKED.
//
// An injected row's TEXT is frozen when the desktop host starts. A
// configuration snapshot inside this text would therefore be a snapshot that
// never updates ⇒ the settings would only take effect on a host restart. So
// the slot configuration and the material library are fetched at runtime, every
// time, and the user's last change is the one that counts.
//
// ★ THE BOOT CLIP DOES NOT LOOP.
//
// Its end IS the hand-over signal, and a looping element never fires `ended`.
// A looping boot clip holds the viewport forever and the application never
// comes up. ⇒ `loop` is decided by the arbitration point, per slot, and the
// boot slot's is `false`.
//
// ★ THE HAND-OVER HAS THREE EXITS, AND NONE OF THEM TRAPS THE USER.
//
//   ① the material ended;
//   ② `ENDLESS_MS` expired — the material's length is unknowable, so its end
//      can never arrive;
//   ③ the kernel is ready and there is NOTHING TO SHOW — no material is
//      configured, it cannot be resolved from the library, or it never painted
//      a frame.
//
// ③ is the one that is easy to get wrong: a boot screen with nothing to play
// that waits for a clip that will never come is a screen that holds the
// viewport forever.
//
// ★ THE HOST'S OWN READINESS SIGNAL IS THE KERNEL'S SIDE OF THE DEAL.
//
// `globalThis.__DSH_BOOT_READY__` is the Host's boot-readiness deferred. It
// may not exist YET — this row lives in <head> and the Host creates the
// deferred in a script at the end of the body ⇒ the global is polled for,
// with a bound.
//
// ★ THE RELEASE ORDER IS A CONTRACT, AND IT IS NOT INTERCHANGEABLE.
//
//   pause → clear the source → unbind the listeners → disconnect the observer
//        → clear the timers → remove the elements
//
// "Clear the source" is not optional and it comes FIRST, right after the
// pause: the browser keeps downloading and decoding a media element whose
// source is still attached, and a half-decoded body is worse than no body.
//
// ★ THE HAND-OVER FADES; THE RELEASE DOES NOT.
//
// The dissolve is part of the show: the overlay fades as a unit so the
// application underneath is not veiled by anything once the exit starts. What
// follows it — the release — is the teardown above, and it plays no exit
// effect of its own.
//
// ★ THE MARKER OF ANOTHER WALLPAPER PLUGIN IS READ, NEVER WRITTEN.
//
// When that plugin is on the stage this surface yields: the media, the layer
// and the injected style go away, and the WATCHER STAYS — so the boot screen
// can come back when the other plugin leaves. The slot's `enabled` flag is
// never touched: the user did not turn it off.
//
// ★ THE BOOT SCREEN HAS NO SOUND SWITCH.
//
// The surface cannot reach the renderer — the arbitration point owns it — so
// there is no `mute()` to call. Sound is decided by `options.boot.muted`,
// which the arbitration point pushes onto the material.
//
// ★ NO BOOT PROGRESS BAR.
//
// The upstream plugin drove a bar from the kernel's `--dsh-boot-arc` spinner.
// This build does not observe that: the readiness signal is the signal, and a
// bar that never moves is the one visible lie on the screen.

/* eslint-disable */
;(function () {
  'use strict'

  /** The slot this surface owns. */
  var SLOT = 'boot'

  /** Where the slot configuration is read from. Always read live. */
  var SLOTS_URL = '/appearance-media/slots'

  /** Where the material library is read from. Always read live. */
  var CATALOG_URL = '/appearance-media/catalog.json'

  /**
   * The upper bound for a material that cannot report its own end.
   *
   * ★ PORTED. A material whose length is unknown — a MediaRecorder WebM
   * reports `duration = Infinity`, and a still picture has no duration at all —
   * never fires `ended`. Without this bound the boot screen would hold the
   * viewport forever.
   */
  var ENDLESS_MS = 20000

  /**
   * The budget for the kernel to become ready.
   *
   * ★ PORTED. When the budget runs out the caption says the start is slow and
   * offers a way out. The value comes from the configuration; this is only the
   * fallback.
   */
  var HOLD_BUDGET_DEFAULT_MS = 15000

  /**
   * The dissolve, when the configuration does not say otherwise.
   *
   * ★ PORTED. A zero is a hard cut, which is a legitimate choice.
   */
  var FADE_DEFAULT_MS = 2000

  /**
   * The watchdog for a material that never paints a frame.
   *
   * ★ PORTED. A material that starts and never shows anything would hold the
   * screen on a bare gradient.
   */
  var WATCHDOG_MS = 6000

  /**
   * The bounded wait for the material library.
   *
   * ★ PORTED. A library that never answers must not hold the viewport.
   */
  var CATALOG_WINDOW_MS = 10000

  /** How often the readiness deferred is looked for, in milliseconds. */
  var KERNEL_POLL_MS = 50

  /** How many times the readiness deferred is looked for before giving up. */
  var KERNEL_POLL_ATTEMPTS = 400
  // ★ HOW LONG THE SURFACE WAITS FOR THE READINESS SIGNAL, IN MILLISECONDS.
  // The bound on the POLL is only about the gate not existing yet; a gate
  // that exists and whose promise never settles needs a bound of its own.
  var KERNEL_WAIT_MS = 20000

  /** How often the surface re-evaluates itself, in milliseconds. */
  var POLL_MS = 1000

  /** The layer element: the surface's own element, mounted on the body. */
  var layerElement = null

  /** The stage element: the media is mounted into this. */
  var stageElement = null

  /** The caption element: the one line of text at the bottom. */
  var captionElement = null

  /** The style element: the overlay's CSS. */
  var styleElement = null

  /** The media element the arbitration point mounted into the stage. */
  var mediaElement = null

  /** The observer that watches the body for the other plugin's marker. */
  var observer = null

  /** The poll timer, or null when it is not running. */
  var pollTimer = null

  /** The watchdog timer, or null when nothing is playing. */
  var watchdogTimer = null

  /** The endless bound, or null when nothing is playing. */
  var endlessTimer = null

  /** The timer that carries the dissolve out and starts the release. */
  var handoverTimer = null

  /** The bounded wait for the material library. */
  var catalogTimer = null

  /** The hold budget timer. */
  var holdTimer = null

  /** The timer that looks for the readiness deferred. */
  var kernelPollTimer = null

  /** The unsubscribe function of the arbitration point's subscription. */
  var offChange = null

  /** Whether the keyboard listener is bound. */
  var keyBound = false

  /** Whether the pointer listener is bound. */
  var pointerBound = false

  /** Whether this surface's host is registered with the arbitration point. */
  var hostRegistered = false

  /** The elements whose removal is deferred to the end of the current release. */
  var deferredRemovals = []

  /** Whether a release is in progress (the change events during it are ignored). */
  var releasing = false

  /** Whether the screen has handed the viewport over for good. */
  var released = false

  /** Whether another wallpaper plugin took the stage. */
  var yielded = false

  /** Whether the kernel has reported itself ready. */
  var kernelReady = false

  /** Whether the kernel has reported a failure. */
  var kernelFailed = false

  /** What is happening: 'none' | 'loading' | 'playing' | 'over' | 'failed'. */
  var clipState = 'none'

  /**
   * Whether OUR material is on the stage right now.
   *
   * ★ THE STAGE IS EMPTY AT START-UP, AND THAT IS NOT A LOSS OF THE STAGE.
   *
   * The arbitration point publishes a change before anything has been
   * applied, and at that moment nobody holds the stage. A surface that reads
   * "the stage is not mine" as "somebody took it from me" tears its own
   * overlay down before it has ever shown anything. ⇒ the flag says whether
   * this surface put something on the stage.
   */
  var materialApplied = false

  /**
   * Whether the surface has finished its FIRST evaluation.
   *
   * ★ THE KERNEL-READY EXIT NEEDS THIS. The readiness signal can arrive
   * before the surface has even looked at the configuration, and "there is
   * nothing to show" is only true once the surface has looked.
   */
  var evaluated = false

  /** The slot revision of the material that was applied. */
  var lastRevision = -1

  /** The id of the material that was applied. */
  var lastMediaId = null

  /** What the last apply answered. */
  var lastResult = null

  /** The boot options, as they were read last. */
  var bootOptions = {}

  /** The timer that gives up on a readiness signal that never comes. */
  var kernelFailTimer = null

  /**
   * The key the pool's recent picks are remembered under.
   *
   * ★ PORTED. The upstream plugin remembers the last picks in
   * `sessionStorage` under a key of its own; this is ours, and it carries the
   * same idea: "do not hand out the same material twice in a row" needs a
   * memory that outlives the page.
   */
  var RECENT_KEY = 'dsh-appearance-media:boot:recent'

  /**
   * Whether the tail dissolve has already started.
   *
   * ★ THE TAIL DISSOLVE HAPPENS ONCE. The check runs on every frame and on
   * every `timeupdate`, and the second one must not start a second dissolve.
   */
  var tailEntered = false

  /**
   * Whether the material has painted a frame.
   *
   * ★ THE TAIL DISSOLVE NEEDS A PICTURE TO DISSOLVE. A material that never
   * showed anything has nothing to cross-fade into the application.
   */
  var frameShown = false

  /** The timer that drives the tail check, or null when it is not running. */
  var tailTimer = null

  /** The frame handle of the tail check, or null when it is not running. */
  var tailFrame = null

  /** Whether a re-evaluation is already running. */
  var busy = false

  /** Whether the missing-arbitration-point warning was already printed. */
  var warned = false

  /**
   * The CSS of the overlay.
   *
   * ★ THE MEDIA RULES ARE SCOPED UNDER THE LAYER.
   *
   * Every material element carries the same class, and the background surface
   * uses it too ⇒ a rule on the class itself would restyle the background's
   * media as well. The rules below only ever match inside our own layer.
   *
   * ★ `z-index` IS A LARGE POSITIVE VALUE. The boot screen owns the viewport
   * before the application exists, so it has to be above everything — and never
   * below anything.
   *
   * @returns the CSS text.
   */
  function overlayCss() {
    return [
      '.dsham-boot-layer{position:fixed;inset:0;z-index:2147483647;overflow:hidden;',
      'background:radial-gradient(circle at 50% 42%,#0b1b2e 0%,#050b14 62%,#000 100%);',
      'font-family:system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif;',
      'color:#dbeaf7;cursor:pointer;-webkit-user-select:none;user-select:none;',
      'opacity:1;transition:opacity 2s ease;}',
      '.dsham-boot-stage{position:absolute;inset:0;}',
      '.dsham-boot-layer .dsham-media{position:absolute;inset:0;width:100%;height:100%;',
      'object-fit:cover;opacity:0;transition:opacity 1.1s ease;}',
      '.dsham-boot-veil{position:absolute;inset:0;pointer-events:none;',
      'background:radial-gradient(ellipse 86% 78% at 50% 50%,transparent 44%,rgba(4,10,18,.45) 78%,rgba(2,6,12,.7) 100%);}',
      '.dsham-boot-ui{position:absolute;left:0;right:0;bottom:0;padding:26px 30px 24px;',
      'display:flex;flex-direction:column;gap:9px;align-items:center;',
      'text-shadow:0 1px 10px rgba(0,0,0,.6);}',
      '.dsham-boot-title{font-size:12px;letter-spacing:.34em;font-weight:600;color:#9fc4e6;',
      'text-transform:uppercase;opacity:.92;}',
      '.dsham-boot-caption{font-size:12px;color:#8fb3d4;letter-spacing:.12em;opacity:0;',
      'transition:opacity .5s ease;}',
    ].join('\n')
  }

  /**
   * The arbitration point, IF the injected side published one.
   *
   * ★ IT IS NEVER CREATED HERE.
   *
   * @returns the arbitration point, or null when there is none.
   */
  function arbitrationPoint() {
    var found = globalThis.__DSH_APPEARANCE_CONTROLLER__
    if (found === undefined || found === null) return null
    if (typeof found.state !== 'function') return null
    if (typeof found.on !== 'function') return null
    if (typeof found.apply !== 'function') return null
    if (typeof found.release !== 'function') return null
    return found
  }

  /**
   * Whether another wallpaper plugin is on the stage.
   *
   * ★ THIS IS A READ. The marker belongs to the other plugin: it is read, it
   * is never written, and it is never removed.
   *
   * @returns true when the other plugin holds the stage.
   */
  function anotherWallpaperIsOnStage() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return false
    var body = doc.body
    if (body === undefined || body === null) return false
    if (typeof body.getAttribute !== 'function') return false
    var value = body.getAttribute('data-we-wallpaper')
    if (value === undefined || value === null) return false
    return String(value) !== ''
  }

  /**
   * Print a warning once.
   * @param message - the message.
   */
  function warnOnce(message) {
    if (warned) return
    warned = true
    try {
      console.warn('[dsh-appearance-media] ' + message)
    } catch (error) {
      /* a console that cannot print must not stop the surface */
    }
  }

  /**
   * Remove one element from the page.
   * @param element - the element.
   */
  function removeElement(element) {
    if (element === undefined || element === null) return
    if (typeof element.remove === 'function') {
      element.remove()
      return
    }
    var parent = element.parentNode
    if (parent !== undefined && parent !== null && typeof parent.removeChild === 'function') {
      parent.removeChild(element)
    }
  }

  /**
   * Put the style element on the page.
   * @returns the style element, or null when there is no document.
   */
  function ensureStyle() {
    if (styleElement !== null) return styleElement
    var doc = globalThis.document
    if (doc === undefined || doc === null) return null
    if (typeof doc.createElement !== 'function') return null
    var parent = doc.head
    if (parent === undefined || parent === null) parent = doc.documentElement
    if (parent === undefined || parent === null) return null
    var element = doc.createElement('style')
    element.textContent = overlayCss()
    parent.appendChild(element)
    styleElement = element
    return styleElement
  }

  /**
   * Put the overlay on the page.
   *
   * ★ THE BODY IS ONLY APPENDED TO. No attribute, no class and no inline
   * style is written on it — the marker on the body belongs to another plugin.
   *
   * @returns the layer, or null when there is no body yet.
   */
  function ensureLayer() {
    if (layerElement !== null) return layerElement
    var doc = globalThis.document
    if (doc === undefined || doc === null) return null
    var body = doc.body
    if (body === undefined || body === null) return null
    if (typeof doc.createElement !== 'function') return null
    var layer = doc.createElement('div')
    layer.className = 'dsham-boot-layer'
    var stage = doc.createElement('div')
    stage.className = 'dsham-boot-stage'
    var veil = doc.createElement('div')
    veil.className = 'dsham-boot-veil'
    var ui = doc.createElement('div')
    ui.className = 'dsham-boot-ui'
    var title = doc.createElement('div')
    title.className = 'dsham-boot-title'
    title.textContent = 'DeepSeek Harness'
    var caption = doc.createElement('div')
    caption.className = 'dsham-boot-caption'
    caption.textContent = ''
    ui.appendChild(title)
    ui.appendChild(caption)
    layer.appendChild(stage)
    layer.appendChild(veil)
    layer.appendChild(ui)
    body.appendChild(layer)
    layerElement = layer
    stageElement = stage
    captionElement = caption
    // ★ THE SCREEN IS NOT A WALL. A press on the overlay lets the user in
    // early — the same escape the hold budget offers when the start is slow.
    if (typeof layer.addEventListener === 'function') {
      layer.addEventListener('pointerdown', onPointerDown)
      pointerBound = true
    }
    return layerElement
  }

  /**
   * Write one line of text into the caption.
   * @param message - the text. An empty string hides the caption.
   * @param attention - true when the line is a warning.
   */
  function setCaption(message, attention) {
    if (captionElement === null) return
    captionElement.textContent = typeof message === 'string' ? message : ''
    try {
      captionElement.style.opacity = message === '' ? '0' : (attention === true ? '1' : '0.95')
      captionElement.style.color = attention === true ? '#ffd79a' : '#8fb3d4'
    } catch (error) {
      /* the caption is best effort */
    }
  }

  /**
   * The dissolve, in milliseconds.
   *
   * ★ THE VALUE IS READ AT RUNTIME. A zero is a hard cut.
   *
   * @returns the duration.
   */
  function fadeMs() {
    var value = bootOptions.fadeMs
    if (typeof value === 'number' && isFinite(value) && value >= 0 && value <= 5000) {
      return Math.round(value)
    }
    return FADE_DEFAULT_MS
  }

  /**
   * The budget for the kernel to become ready, in milliseconds.
   *
   * ★ THE VALUE IS READ AT RUNTIME.
   *
   * @returns the budget.
   */
  function holdBudgetMs() {
    var value = bootOptions.holdMs
    if (typeof value === 'number' && isFinite(value) && value >= 1000 && value <= 120000) {
      return Math.round(value)
    }
    return HOLD_BUDGET_DEFAULT_MS
  }

  /**
   * How the screen hands the viewport over.
   *
   * ★ PORTED. `tail` dissolves over the material's last fade, `end` plays the
   * material out and fades in afterwards, and `click` never enters on its own.
   *
   * ★ AN UNKNOWN VALUE FALLS BACK TO 'tail' — the upstream plugin's rule, and
   * the safe one: a cross-dissolve at the end is the show the screen has
   * always been, and a mode nobody recognises must not strand the user in
   * front of a screen that never leaves.
   *
   * @returns 'tail' | 'end' | 'click'.
   */
  function enterMode() {
    var value = bootOptions.enterMode
    if (value === 'tail' || value === 'end' || value === 'click') return value
    return 'tail'
  }

  /**
   * Where the material comes from.
   *
   * ★ 'media' IS THE ONE MATERIAL THE SLOT NAMES. 'pool' PICKS ONE OUT OF THE
   * LIBRARY, EVERY TIME. Anything else falls back to 'media'.
   *
   * @returns 'media' | 'pool'.
   */
  function sourceMode() {
    var value = bootOptions.source
    if (value === 'pool') return 'pool'
    return 'media'
  }

  /**
   * The material ids the pool is narrowed to.
   *
   * ★ AN EMPTY LIST MEANS THE WHOLE LIBRARY. That is what the pool mode did
   * before the pool could be narrowed, and it is still the default: the
   * configuration carries an empty list, not a missing field.
   *
   * ★ THE LIST IS READ LIVE. It comes from the Host's own route, with the
   * rest of the configuration, on every poll — a pool the user just edited
   * is the pool that counts.
   *
   * @returns the ids, without blanks and without duplicates.
   */
  function poolIds() {
    var value = bootOptions.pool
    if (!Array.isArray(value)) return []
    var ids = []
    for (var i = 0; i < value.length; i += 1) {
      var id = value[i]
      if (typeof id !== 'string') continue
      var trimmed = id.trim()
      if (trimmed === '') continue
      if (ids.indexOf(trimmed) >= 0) continue
      ids.push(trimmed)
    }
    return ids
  }

  /**
   * The library entries the pool allows.
   *
   * ★ A POOL ID THAT IS NOT IN THE LIBRARY IS NOT A MATERIAL. The user
   * deleted the clip, or the clip was never in the library: the id names
   * nothing that can be played, so that one is ignored — the whole entry,
   * not just this attempt.
   *
   * ★ AND A POOL THAT IS EMPTY IN THE LIBRARY IS NOT A DEAD END. Such a pool
   * falls back to the whole library, which is the behaviour an empty pool
   * has: a pool that cannot narrow anything does not narrow anything.
   *
   * ★ THE FILTER IS HERE, AND NOT IN THE PICKER, BECAUSE THE FALLBACKS HAVE
   * TO BE INSIDE THE POOL TOO. A material that cannot be played must not be
   * replaced by one the user did not put in the pool.
   *
   * @param entries - the library's entries.
   * @returns the entries the pool allows.
   */
  function poolEntries(entries) {
    var ids = poolIds()
    if (ids.length === 0) return entries
    var allowed = []
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i]
      if (entry === undefined || entry === null) continue
      if (typeof entry.id !== 'string') continue
      if (ids.indexOf(entry.id) < 0) continue
      allowed.push(entry)
    }
    if (allowed.length === 0) return entries
    return allowed
  }

  /**
   * Whether the screen may hand the viewport over on its own.
   *
   * ★ CLICK MODE NEVER MAY. The material is the show and the user decides
   * when it is over, so every automatic exit asks this first.
   *
   * @returns true when the screen may leave by itself.
   */
  function mayEnterOnItsOwn() {
    return enterMode() !== 'click'
  }

  /**
   * The hint that tells the user how the screen is left.
   *
   * @param fallback - the hint for the modes that enter on their own.
   * @returns the hint.
   */
  function leaveHint(fallback) {
    if (enterMode() === 'click') return '点击或按任意键进入'
    return typeof fallback === 'string' && fallback !== '' ? fallback : '就绪后自动进入'
  }

  /**
   * The caption of a screen that is playing.
   *
   * @returns the caption.
   */
  function playingCaption() {
    var base = enterMode() === 'click' ? '点击或按任意键进入' : '正在启动 · 点一下提前进入'
    return soundWasGivenUp() === true ? base + ' · 浏览器拦住了自动播放，已静音播放' : base
  }

  /**
   * Whether the material had to give up its sound to start.
   *
   * ★ THE FACT COMES FROM THE ARBITRATION POINT, NOT FROM HERE. This surface
   * asks the controller what it knows about its own slot, and the controller's
   * answer is the one the material published.
   *
   * @returns {boolean} whether the sound was given up.
   */
  function soundWasGivenUp() {
    var controller = arbitrationPoint()
    if (controller === null) return false
    try {
      var current = controller.state()
      if (current === undefined || current === null) return false
      var slots = current.slots !== undefined && current.slots !== null ? current.slots : {}
      var mine = slots[SLOT]
      return mine !== undefined && mine !== null && mine.mutedDowngraded === true
    } catch (error) {
      return false
    }
  }

  /**
   * Find one entry in the material library.
   * @param entries - the library's entries.
   * @param mediaId - the id to look for.
   * @returns the entry, or null.
   */
  function findEntry(entries, mediaId) {
    if (!Array.isArray(entries)) return null
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i]
      if (entry === undefined || entry === null) continue
      if (entry.id === mediaId) return entry
    }
    return null
  }

  /**
   * A shuffled copy of a list.
   *
   * ★ PORTED from the upstream plugin.
   *
   * @param values - the list.
   * @returns the shuffled copy.
   */
  function shuffled(values) {
    var out = values.slice()
    for (var i = out.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1))
      var swap = out[i]
      out[i] = out[j]
      out[j] = swap
    }
    return out
  }

  /**
   * The materials the pool handed out recently, oldest first.
   *
   * @returns the ids.
   */
  function readRecent() {
    var storage = globalThis.sessionStorage
    if (storage === undefined || storage === null) return []
    try {
      var raw = storage.getItem(RECENT_KEY)
      if (raw === undefined || raw === null || raw === '') return []
      var parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
    } catch (error) {
      /* private mode: the rotation degrades to plain random */
      return []
    }
  }

  /**
   * Remember the materials the pool handed out recently.
   *
   * @param list - the ids.
   */
  function writeRecent(list) {
    var storage = globalThis.sessionStorage
    if (storage === undefined || storage === null) return
    try {
      storage.setItem(RECENT_KEY, JSON.stringify(list))
    } catch (error) {
      /* private mode: the rotation degrades to plain random */
    }
  }

  /**
   * Pick one entry out of the pool.
   *
   * ★ PORTED. The upstream plugin keeps the last (N-1) picks and prefers an
   * entry that is not among them, so the pool does not hand out the same
   * material twice in a row. The rule is the upstream's; the storage key is
   * ours.
   *
   * @param entries - the pool. It must not be empty.
   * @returns the chosen entry.
   */
  function pickFromPool(entries) {
    var recent = readRecent()
    var fresh = []
    for (var i = 0; i < entries.length; i += 1) {
      if (recent.indexOf(entries[i].id) < 0) fresh.push(entries[i])
    }
    var pool = fresh.length > 0 ? fresh : entries
    var chosen = pool[Math.floor(Math.random() * pool.length)]
    // ★ THE HISTORY IS NOT WRITTEN HERE.
    //
    // This function runs on EVERY poll of the configuration — once a second —
    // and a history written on every call is a history full of picks that
    // never played. After N-1 polls the "not recently played" rule has no
    // candidate left, the pool degenerates into a plain random pick, and the
    // "the same clip twice in a row" rule stops holding within the first ten
    // seconds of the session. The pick is remembered by `rememberPick()`, at
    // the moment it is actually applied.
    return chosen
  }

  /**
   * Remember a material that was really played.
   *
   * @param id - the material's id.
   * @param poolSize - how many materials the pool holds.
   */
  function rememberPick(id, poolSize) {
    var recent = readRecent()
    recent.push(id)
    var keep = Math.max((poolSize || 1) - 1, 1)
    while (recent.length > keep) recent.shift()
    writeRecent(recent)
  }

  /**
   * The materials this boot may play, in the order they are tried.
   *
   * ★ 'media' IS THE ONE MATERIAL THE SLOT NAMES — nothing is picked, and
   * nothing else is tried. The pool does not narrow it: the user named that
   * material, and a pool of random picks has nothing to say about it.
   *
   * ★ 'pool' PICKS ONE OUT OF THE POOL AND KEEPS THE REST AS FALLBACKS.
   * The upstream plugin does the same: one material that cannot be played
   * must not leave the screen on a bare gradient while the library still
   * holds usable ones.
   *
   * ★ AND THE POOL IS THE FILTER, HERE, AT THE CANDIDATES. The pick and the
   * fallbacks come out of the same list, so a material outside the pool can
   * never be played — not as the pick, and not as the replacement for a pick
   * that cannot be played.
   *
   * @param catalog - the material library.
   * @param mediaId - the material the slot names, or null.
   * @returns the candidates, in order.
   */
  function resolveCandidates(catalog, mediaId) {
    var entries = Array.isArray(catalog.entries) ? catalog.entries : []
    if (sourceMode() !== 'pool') {
      var named = findEntry(entries, mediaId)
      return named === null ? [] : [named]
    }
    // ★ THE POOL NARROWS THE LIBRARY. An empty pool is the whole library, and
    // a pool whose materials are all gone is the whole library too.
    var candidates = poolEntries(entries)
    // ★ AN EMPTY POOL IS NOT A DEAD END: the named material is still tried.
    if (candidates.length === 0) {
      var fallback = findEntry(entries, mediaId)
      return fallback === null ? [] : [fallback]
    }
    var chosen = pickFromPool(candidates)
    var order = [chosen]
    var rest = shuffled(candidates)
    for (var i = 0; i < rest.length; i += 1) {
      if (rest[i].id !== chosen.id) order.push(rest[i])
    }
    return order
  }

  /**
   * Turn a media id into the library entry that carries the media URL.
   *
   * ★ THE ARBITRATION POINT REMEMBERS IDS, NOT URLS. It asks the surface that
   * owns the slot, and the surface answers with the entry the library
   * published — the URL is never built by hand.
   *
   * ★ AND THE ANSWER IS THE CURRENT ONE. The library is read again every
   * time, so a hand-over gives back the material that is in the library NOW,
   * not the one that was in it the last time.
   *
   * @param mediaId - the media id.
   * @returns a promise for the entry, or null when it cannot be resolved.
   */
  function resolveEntry(mediaId) {
    if (typeof mediaId !== 'string' || mediaId === '') return Promise.resolve(null)
    return readCatalog().then(function (catalog) {
      return findEntry(catalog.entries, mediaId)
    }).catch(function (error) {
      return null
    })
  }

  /**
   * Read the slot configuration.
   * @returns a promise for the answer.
   */
  function readSlots() {
    var fetcher = globalThis.fetch
    if (typeof fetcher !== 'function') return Promise.reject(new Error('这个环境没有 fetch。'))
    return Promise.resolve(fetcher(SLOTS_URL, { cache: 'no-store' })).then(function (response) {
      if (response === undefined || response === null || response.ok !== true) {
        throw new Error('宿主没有应答槽位配置。')
      }
      return response.json()
    }).then(function (payload) {
      if (payload === undefined || payload === null || typeof payload !== 'object') {
        throw new Error('槽位配置的形状不对。')
      }
      var config = payload.config
      if (config === undefined || config === null || typeof config !== 'object') {
        throw new Error('槽位配置的形状不对。')
      }
      return payload
    })
  }

  /**
   * Read the material library.
   * @returns a promise for the answer.
   */
  function readCatalog() {
    var fetcher = globalThis.fetch
    if (typeof fetcher !== 'function') return Promise.reject(new Error('这个环境没有 fetch。'))
    return Promise.resolve(fetcher(CATALOG_URL, { cache: 'no-store' })).then(function (response) {
      if (response === undefined || response === null || response.ok !== true) {
        throw new Error('宿主没有应答素材库。')
      }
      return response.json()
    }).then(function (payload) {
      if (payload === undefined || payload === null || typeof payload !== 'object') {
        throw new Error('素材库的形状不对。')
      }
      return payload
    })
  }

  /**
   * Wait until the document has a body.
   *
   * This row lives in <head>, so the body may not exist yet when it runs.
   *
   * @returns a promise that answers true when the body is there.
   */
  function whenBodyReady() {
    return new Promise(function (resolve) {
      var doc = globalThis.document
      if (doc === undefined || doc === null) {
        resolve(false)
        return
      }
      if (doc.body !== undefined && doc.body !== null) {
        resolve(true)
        return
      }
      if (typeof doc.addEventListener !== 'function') {
        resolve(false)
        return
      }
      doc.addEventListener('DOMContentLoaded', function () { resolve(true) }, { once: true })
    })
  }

  /**
   * The host interface the arbitration point uses for THIS slot.
   *
   * The element lands inside the stage, and it leaves the page during the
   * LAST step of a release — not before the observer and the timers are done.
   *
   * ★ IT ALSO CARRIES `ensure()` AND `resolve()`.
   *
   *   `ensure()`   make sure the overlay is there. The arbitration point asks
   *                before it mounts, because a release takes the overlay away.
   *   `resolve()`  turn a media id into the library entry that carries the
   *                media URL.
   *
   * @returns the host interface.
   */
  function mediaHost() {
    return {
      createElement: function (tag) {
        var doc = globalThis.document
        if (doc === undefined || doc === null) return null
        return doc.createElement(tag)
      },
      mount: function (element) {
        mediaElement = element
        // ★ THE MEDIA IS POSITIONED BY ITSELF, NOT ONLY BY THE STYLE SHEET.
        try {
          element.style.position = 'absolute'
          element.style.inset = '0px'
          element.style.width = '100%'
          element.style.height = '100%'
          element.style.objectFit = 'cover'
          element.style.pointerEvents = 'none'
        } catch (error) {
          /* the element does not have a style object */
        }
        var target = stageElement
        if (target === undefined || target === null) return
        target.appendChild(element)
        watchMedia(element)
      },
      unmount: function (element) {
        // ★ A SWITCHED MATERIAL LEAVES THE PAGE RIGHT NOW. Only a FULL
        // release defers the removal: there the contract puts "remove the
        // elements" last, after the observer and the timers are done.
        if (releasing !== true) {
          removeElement(element)
          return
        }
        deferredRemovals.push(element)
      },
      // ★ MAKE SURE THE OVERLAY IS THERE.
      ensure: function () {
        if (ensureStyle() === null) return null
        if (ensureLayer() === null) return null
        ensureObserver()
        return true
      },
      // ★ THE ENTRY COMES FROM THE LIBRARY, NEVER FROM A HAND-WRITTEN URL.
      resolve: function (mediaId) { return resolveEntry(mediaId) },
    }
  }

  /**
   * Register this surface's host with the arbitration point, for its slot.
   *
   * ★ THE REGISTRATION IS PER SLOT AND IT IS NOT A GLOBAL SWAP. It stays
   * registered for as long as the surface lives, so the arbitration point's
   * own `apply()` mounts the material into the same stage.
   *
   * @returns true when the host is registered.
   */
  function registerMediaHost() {
    if (hostRegistered === true) return true
    var controller = arbitrationPoint()
    if (controller === null) return false
    if (typeof controller.registerHost !== 'function') return false
    try {
      if (controller.registerHost(SLOT, mediaHost()) === true) {
        hostRegistered = true
        return true
      }
      return false
    } catch (error) {
      return false
    }
  }

  /**
   * Forget this surface's host.
   *
   * ★ THIS IS THE END OF THE SURFACE, NOT A RELEASE. A release keeps the
   * registration: the surface can be asked for its overlay again.
   */
  function unregisterMediaHost() {
    var controller = arbitrationPoint()
    if (controller === null) return
    if (typeof controller.unregisterHost !== 'function') return
    try {
      controller.unregisterHost(SLOT)
    } catch (error) {
      /* the registration is best effort */
    }
    hostRegistered = false
  }

  /**
   * Watch the material that is on the stage.
   *
   * ★ THE ELEMENT IS THE OBSERVABLE. The surface does not own the adapter —
   * the arbitration point does — so the element is where the facts are: the
   * frame, the end and the error.
   *
   * @param element - the media element.
   */
  function watchMedia(element) {
    if (element === undefined || element === null) return
    if (typeof element.addEventListener !== 'function') return
    element.addEventListener('loadeddata', onMediaFrame)
    element.addEventListener('canplay', onMediaFrame)
    element.addEventListener('timeupdate', onMediaFrame)
    element.addEventListener('ended', onMediaEnded)
    element.addEventListener('error', onMediaError)
    // ★ THE WATCHDOG. A material that starts and never paints anything would
    // hold the screen on a bare gradient.
    if (watchdogTimer !== null) globalThis.clearTimeout(watchdogTimer)
    watchdogTimer = globalThis.setTimeout(onMediaWatchdog, WATCHDOG_MS)
    // ★ THE UPPER BOUND. A material whose length is unknown never reports an
    // end — a MediaRecorder WebM reports `duration = Infinity`, and a still
    // picture has no duration at all — so the bound is what releases the
    // screen for those.
    if (endlessTimer !== null) globalThis.clearTimeout(endlessTimer)
    endlessTimer = globalThis.setTimeout(onMediaEndless, ENDLESS_MS)
  }

  /**
   * The material painted a frame.
   *
   * ★ A RESOLVED `play()` IS NOT A PICTURE. The element has to have decoded
   * data, or its clock has to have moved.
   */
  function onMediaFrame() {
    if (clipState !== 'playing') return
    var element = mediaElement
    if (element === undefined || element === null) return
    var ready = typeof element.readyState === 'number' && element.readyState >= 2
    var moved = typeof element.currentTime === 'number' && element.currentTime > 0
    if (!ready && !moved) return
    // ★ THE REVEAL. The material starts at `opacity: 0`, so a screen that shows
    // nothing is a screen waiting for a frame it never got.
    try {
      element.style.opacity = '1'
    } catch (error) {
      /* the element does not have a style object */
    }
    if (watchdogTimer !== null) {
      globalThis.clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    // ★ THE PICTURE IS THERE. The tail dissolve needs one, and this is the
    // only place that knows it.
    frameShown = true
    // ★ THE TAIL DISSOLVE IS AIMED FROM HERE TOO. The media's clock keeps
    // moving in a tab the browser stopped painting, and the event still
    // arrives there.
    tailCheck()
  }

  /**
   * The material ended. That IS the hand-over signal.
   */
  function onMediaEnded() {
    if (released === true) return
    if (clipState === 'over') return
    clipState = 'over'
    if (endlessTimer !== null) {
      globalThis.clearTimeout(endlessTimer)
      endlessTimer = null
    }
    // ★ IN CLICK MODE THE MATERIAL ENDING IS NOT AN EXIT. The user decides
    // when the show is over.
    if (mayEnterOnItsOwn() === false) {
      setCaption('点击或按任意键进入', false)
      return
    }
    // ★ THE APPLICATION MUST BE UP BEFORE THE SCREEN LEAVES.
    //
    // A clip that ends before the kernel is ready must NOT hand the viewport
    // over: the overlay would be torn down over an empty shell and the user
    // would see a flash of nothing where the application should be. The
    // upstream plugin holds the last frame and waits, with a hint, and the
    // hand-over happens when the readiness signal arrives.
    if (kernelReady !== true && kernelFailed !== true) {
      setCaption('启动较慢，就绪后自动进入', false)
      return
    }
    beginHandover('ended')
  }

  /**
   * The material failed.
   */
  function onMediaError() {
    if (released === true) return
    clipState = 'failed'
    setCaption('片段无法播放 · ' + leaveHint('正在进入'), false)
    maybeRelease()
  }

  /**
   * The material never painted a frame.
   */
  function onMediaWatchdog() {
    watchdogTimer = null
    if (released === true) return
    if (clipState !== 'playing') return
    clipState = 'failed'
    setCaption('片段无法播放 · ' + leaveHint('正在进入'), false)
    maybeRelease()
  }

  /**
   * The upper bound expired: the material's end can never arrive.
   */
  function onMediaEndless() {
    endlessTimer = null
    if (released === true) return
    clipState = 'over'
    // ★ IN CLICK MODE THE SCREEN NEVER LEAVES ON ITS OWN — not even here.
    if (mayEnterOnItsOwn() === false) {
      setCaption('点击或按任意键进入', false)
      return
    }
    // ★ THE SAME GATE AS THE END OF THE MATERIAL. Three paths leave this
    // screen — the clip ended, the upper bound expired, the kernel came up
    // with nothing to show — and all three ask the same question first: is
    // the application up yet? A path that skips the question hands the
    // viewport over to an empty shell.
    if (kernelReady !== true && kernelFailed !== true) {
      setCaption('启动较慢，就绪后自动进入', false)
      return
    }
    beginHandover('endless')
  }

  /**
   * Aim the dissolve at the material's last frame.
   *
   * ★ PORTED. The upstream plugin's `tail` mode starts the dissolve when the
   * material has FADE_MS left, and the dissolve takes exactly that long, so
   * the picture and the application arrive together.
   *
   * Five facts have to hold, and each one is a way this check can be wrong:
   *
   *   ① the mode is `tail` — the other two modes have nothing to aim at;
   *   ② there is a picture — a material that never painted has nothing to
   *      cross-fade;
   *   ③ the length is known — a material without one never reaches a tail;
   *   ④ it is long enough to carry the dissolve — a short one would have to
   *      start before there is anything to dissolve;
   *   ⑤ the kernel is ready — the dissolve IS the application appearing.
   */
  function tailCheck() {
    if (tailEntered === true) return
    if (enterMode() !== 'tail') return
    if (clipState !== 'playing') return
    if (frameShown !== true) return
    if (kernelReady !== true) return
    var element = mediaElement
    if (element === undefined || element === null) return
    var duration = typeof element.duration === 'number' ? element.duration : Number.NaN
    if (!isFinite(duration)) return
    var span = fadeMs()
    // ★ TOO SHORT TO CARRY THE DISSOLVE. It would have to start before there
    // is any picture to dissolve; those play out and fade afterwards.
    if (duration * 1000 < span * 2) return
    if (element.ended === true) return
    if (element.paused === true) return
    var remaining = (duration - element.currentTime) * 1000
    if (!isFinite(remaining)) return
    if (remaining > span || remaining <= 0) return
    tailEntered = true
    beginHandover('tail', remaining)
  }

  /**
   * One step of the tail watch.
   */
  function tailTick() {
    tailTimer = null
    tailFrame = null
    if (released === true) return
    if (tailEntered === true) return
    tailCheck()
    if (released === true || tailEntered === true) return
    if (clipState !== 'playing') return
    scheduleTailTick()
  }

  /**
   * Schedule the next step of the tail watch.
   *
   * ★ A FRAME LOOP WHERE THERE IS ONE. The frame loop is frame-accurate while
   * the tab is visible and stops when it is not — and the media's own clock
   * keeps moving while the frames are gone, which is what the `timeupdate`
   * backstop is for.
   */
  function scheduleTailTick() {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      tailFrame = globalThis.requestAnimationFrame(tailTick)
      return
    }
    tailTimer = globalThis.setTimeout(tailTick, 50)
  }

  /**
   * Watch the material's own clock for the tail window.
   */
  function startTailWatch() {
    stopTailWatch()
    if (enterMode() !== 'tail') return
    scheduleTailTick()
  }

  /**
   * Stop watching the material's own clock.
   */
  function stopTailWatch() {
    if (tailTimer !== null) {
      globalThis.clearTimeout(tailTimer)
      tailTimer = null
    }
    if (tailFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(tailFrame)
      tailFrame = null
    }
  }

  /**
   * Hand the viewport over.
   *
   * ★ THE DISSOLVE IS PART OF THE SHOW. The whole overlay fades as a unit, so
   * the application underneath is not veiled by anything once the exit starts.
   * The RELEASE that follows is the teardown, and it plays no exit effect.
   *
   * @param reason - why the screen is leaving.
   * @param requestedSpan - how long the dissolve takes. The tail dissolve
   *   passes the material's remaining time, so the fade lands exactly on its
   *   last frame; every other exit passes nothing and gets the configured
   *   fade.
   */
  function beginHandover(reason, requestedSpan) {
    if (released === true) return
    released = true
    lastResult = reason
    // ★ THE TAIL DISSOLVE TAKES EXACTLY THE TIME THE MATERIAL HAS LEFT, and
    // it is clamped to the configured fade: a dissolve longer than the fade
    // would hold the user on a decorative screen.
    var span = typeof requestedSpan === 'number' && requestedSpan > 0
      ? Math.max(Math.min(requestedSpan, fadeMs()), 120)
      : fadeMs()
    if (layerElement !== null) {
      try {
        layerElement.style.transitionDuration = (span / 1000) + 's'
        layerElement.style.opacity = '0'
        layerElement.style.pointerEvents = 'none'
      } catch (error) {
        /* the layer does not have a style object */
      }
    }
    setCaption('', false)
    if (handoverTimer !== null) globalThis.clearTimeout(handoverTimer)
    handoverTimer = globalThis.setTimeout(function () {
      handoverTimer = null
      releaseBoot()
    }, span + 100)
  }

  /**
   * Release the boot screen.
   *
   * ★ THE ORDER IS THE CONTRACT:
   *
   *   pause → clear the source → unbind → disconnect → clear the timers →
   *   remove the elements
   *
   * The media's own teardown belongs to the adapter, and the arbitration point
   * calls it. This surface adds its own steps around it and removes the
   * elements LAST.
   */
  function releaseBoot() {
    if (releasing === true) return
    releasing = true
    try {
      // ① the media: pause → clear the source → unbind its listeners.
      releaseMedia()
      // ② this surface's own listeners.
      if (offChange !== null) {
        try { offChange() } catch (error) { /* the subscription is best effort */ }
        offChange = null
      }
      if (keyBound === true) {
        var doc = globalThis.document
        if (doc !== undefined && doc !== null && typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('keydown', onKeyDown)
        }
        keyBound = false
      }
      if (pointerBound === true && layerElement !== null) {
        if (typeof layerElement.removeEventListener === 'function') {
          layerElement.removeEventListener('pointerdown', onPointerDown)
        }
        pointerBound = false
      }
      unbindMedia()
      // ③ the observer.
      if (observer !== null) {
        try { observer.disconnect() } catch (error) { /* the observer is best effort */ }
        observer = null
      }
      // ④ the timers.
      if (pollTimer !== null) {
        if (typeof globalThis.clearInterval === 'function') globalThis.clearInterval(pollTimer)
        pollTimer = null
      }
      if (watchdogTimer !== null) {
        globalThis.clearTimeout(watchdogTimer)
        watchdogTimer = null
      }
      if (endlessTimer !== null) {
        globalThis.clearTimeout(endlessTimer)
        endlessTimer = null
      }
      if (catalogTimer !== null) {
        globalThis.clearTimeout(catalogTimer)
        catalogTimer = null
      }
      if (holdTimer !== null) {
        globalThis.clearTimeout(holdTimer)
        holdTimer = null
      }
      if (kernelPollTimer !== null) {
        globalThis.clearTimeout(kernelPollTimer)
        kernelPollTimer = null
      }
      // ★ THE TAIL WATCH IS A TIMER TOO, AND IT GOES WITH THE OTHERS.
      stopTailWatch()
      // ⑤ the elements.
      flushDeferredRemovals()
      removeElement(layerElement)
      removeElement(styleElement)
      layerElement = null
      stageElement = null
      captionElement = null
      styleElement = null
      mediaElement = null
      materialApplied = false
      // ★ THE HOST IS NOT FORGOTTEN. A release takes the OVERLAY away, and the
      // overlay is built again when the next material asks for it — the host's
      // `ensure()` does that.
    } finally {
      releasing = false
    }
    reportFacts()
  }

  /**
   * Unbind this surface's own listeners on the media element.
   */
  function unbindMedia() {
    var element = mediaElement
    if (element === undefined || element === null) return
    if (typeof element.removeEventListener !== 'function') return
    element.removeEventListener('loadeddata', onMediaFrame)
    element.removeEventListener('canplay', onMediaFrame)
    element.removeEventListener('timeupdate', onMediaFrame)
    element.removeEventListener('ended', onMediaEnded)
    element.removeEventListener('error', onMediaError)
  }

  /**
   * Take the media off the page.
   *
   * The arbitration point releases it, and the adapter tears it down in its
   * own order: pause, clear the source, unbind the listeners.
   */
  function releaseMedia() {
    var controller = arbitrationPoint()
    if (controller === null) return
    try {
      controller.release(SLOT)
    } catch (error) {
      /* the release is best effort */
    }
  }

  /**
   * Remove the elements whose removal was deferred to the end of a release.
   */
  function flushDeferredRemovals() {
    for (var i = 0; i < deferredRemovals.length; i += 1) {
      removeElement(deferredRemovals[i])
    }
    deferredRemovals.length = 0
  }

  /**
   * Publish this surface's own facts into the arbitration point's state.
   */
  function reportFacts() {
    var controller = arbitrationPoint()
    if (controller === null) return
    if (typeof controller.report !== 'function') return
    try {
      controller.report(SLOT, {
        clip: clipState,
        kernelReady: kernelReady,
        released: released,
      })
    } catch (error) {
      /* the facts are best effort */
    }
  }

  /**
   * Arm the observer that watches the body for the other plugin's marker.
   */
  function ensureObserver() {
    if (observer !== null) return
    var Ctor = globalThis.MutationObserver
    if (typeof Ctor !== 'function') return
    var doc = globalThis.document
    if (doc === undefined || doc === null) return
    var body = doc.body
    if (body === undefined || body === null) return
    observer = new Ctor(function () {
      onMarkerChanged()
    })
    try {
      observer.observe(body, { attributes: true })
    } catch (error) {
      observer = null
    }
  }

  /**
   * The other plugin's marker appeared or disappeared.
   *
   * ★ THE WATCHER STAYS. Yielding takes the media, the layer and the style
   * away — the stage is handed over CLEAN — but the observer and the timer
   * stay, so the boot screen can come back when the other plugin leaves.
   *
   * ★ AND THE SLOT'S `enabled` FLAG IS NOT TOUCHED. The user did not turn the
   * boot screen off.
   */
  function onMarkerChanged() {
    if (releasing === true) return
    if (released === true) return
    if (anotherWallpaperIsOnStage()) {
      if (yielded === true) return
      yielded = true
      // ★ THE STAGE IS HANDED OVER CLEAN: the media, the overlay and the
      // injected style, all of it.
      yieldStage()
      return
    }
    if (yielded === false) return
    yielded = false
    // ★ THE OTHER PLUGIN LEFT ⇒ THE BOOT SCREEN COMES BACK.
    lastRevision = -1
    refresh()
  }

  /**
   * Hand the stage to the other wallpaper plugin.
   *
   * The media and the overlay go; the watcher stays.
   */
  function yieldStage() {
    if (releasing === true) return
    releasing = true
    try {
      releaseMedia()
      flushDeferredRemovals()
      removeElement(layerElement)
      removeElement(styleElement)
      layerElement = null
      stageElement = null
      captionElement = null
      styleElement = null
      mediaElement = null
      materialApplied = false
    } finally {
      releasing = false
    }
    reportFacts()
  }

  /**
   * Arm the surface's machinery: the host registration, the subscription, the
   * listeners, the observer and the timers.
   */
  function ensureRunning() {
    var controller = arbitrationPoint()
    if (controller === null) {
      warnOnce('没有仲裁点，片头表面不注册。')
      return false
    }
    // ★ THE HOST IS REGISTERED FIRST. Whoever asks for the boot material —
    // this surface or the arbitration point itself — gets it inside this
    // surface's stage.
    registerMediaHost()
    if (offChange === null) {
      try {
        offChange = controller.on('change', onChange)
      } catch (error) {
        offChange = null
      }
    }
    var doc = globalThis.document
    if (keyBound !== true && doc !== undefined && doc !== null
      && typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', onKeyDown)
      keyBound = true
    }
    ensureObserver()
    if (pollTimer === null && typeof globalThis.setInterval === 'function') {
      pollTimer = globalThis.setInterval(function () { refresh() }, POLL_MS)
    }
    return true
  }

  /**
   * The hold budget ran out and the kernel has still not settled.
   */
  function onHoldBudgetExpired() {
    holdTimer = null
    if (released === true) return
    if (kernelReady === true) return
    setCaption('启动较慢 · 点一下继续', true)
  }

  /**
   * The arbitration point published a change.
   * @param payload - the change payload.
   */
  function onChange(payload) {
    if (payload === undefined || payload === null) return
    // ★ A RELEASE IN PROGRESS IGNORES THE CHANGE EVENTS. The arbitration
    // point publishes one while it releases, and re-applying the material in
    // the middle of a teardown would put it straight back.
    if (releasing === true) return
    if (released === true) return
    var current = payload.state
    var stage = current !== undefined && current !== null ? current.slot : null
    var slots = current !== undefined && current !== null && current.slots !== undefined && current.slots !== null
      ? current.slots : {}
    var mine = slots[SLOT]
    var enabled = mine !== undefined && mine !== null && mine.enabled === true

    // ★ THE BOOT SCREEN IS NOT ON THE STAGE ⇒ THE OVERLAY GOES TOO — but
    // only when OUR material was the one on it. An empty stage at start-up is
    // not a lost stage.
    if (materialApplied === true && stage !== SLOT
      && (layerElement !== null || mediaElement !== null)) {
      releaseBoot()
      return
    }
    // ★ THE SLOT IS OFF ⇒ THE OVERLAY GOES WITH IT — again, only when there
    // was something of ours on the stage.
    if (materialApplied === true && enabled !== true
      && (layerElement !== null || mediaElement !== null)) {
      releaseBoot()
      return
    }
    var changed = Array.isArray(payload.changed) ? payload.changed : []
    // ★ THE SOUND WAS GIVEN UP. The clip is on screen, but the browser refused
    //   to start it with sound, so the caption says so — and this is checked
    //   BEFORE the "nothing changed for us" bail-out, because the downgrade IS
    //   a change for this slot.
    if (mine !== undefined && mine !== null && mine.mutedDowngraded === true
      && clipState === 'playing' && materialApplied === true) {
      setCaption(playingCaption(), false)
    }
    if (changed.indexOf(SLOT) === -1 && payload.optionsChanged !== true) return
    refresh()
  }

  /**
   * The user pressed the keyboard. Any key that means "let me in" ends the
   * boot screen.
   * @param event - the keyboard event.
   */
  function onKeyDown(event) {
    if (released === true) return
    if (event === undefined || event === null) return
    var key = event.key
    if (key !== 'Escape' && key !== ' ' && key !== 'Enter') return
    beginHandover('user')
  }

  /**
   * The user pressed the overlay. The boot screen is a screen, not a wall.
   * @param event - the pointer event.
   */
  function onPointerDown(event) {
    if (released === true) return
    beginHandover('user')
  }

  /**
   * Play one entry.
   * @param entry - the library entry.
   * @returns what the arbitration point answered.
   */
  function applyEntry(entry) {
    var controller = arbitrationPoint()
    if (controller === null) {
      warnOnce('没有仲裁点，片头表面不注册。')
      return 'no-arbitration-point'
    }
    // ★ THE ARBITRATION POINT IS THE ONLY PATH TO THE MEDIA — and it asks
    // this surface for its host first, so the overlay is there and the element
    // lands inside the stage. There is no second way to play anything.
    var result = controller.apply(SLOT, entry)
    lastResult = typeof result === 'string' ? result : 'applied'
    if (lastResult === 'applied') materialApplied = true
    reportFacts()
    return lastResult
  }

  /**
   * Re-evaluate the surface: read the configuration, and play or withdraw.
   * @returns a promise for what happened.
   */
  function refresh() {
    if (busy === true) return Promise.resolve(null)
    busy = true
    return whenBodyReady().then(function (ready) {
      if (ready !== true) return null
      ensureObserver()
      if (ensureRunning() === false) return null
      // ★ THE OTHER PLUGIN IS ON THE STAGE ⇒ THIS SURFACE YIELDS.
      //
      // And it does not raise an overlay at all while the other plugin holds
      // the stage: an overlay that is built and taken down again on every
      // re-evaluation is a flicker, not a hand-over.
      if (anotherWallpaperIsOnStage()) {
        if (yielded === false) {
          yielded = true
          yieldStage()
        }
        return null
      }
      if (yielded === true) {
        // ★ THE OTHER PLUGIN LEFT ⇒ THE BOOT SCREEN COMES BACK.
        yielded = false
        lastRevision = -1
      }
      // ★ THE OVERLAY COMES UP FIRST, BEFORE THE MATERIAL. The gradient and
      // the caption are the screen; the material is what fills it.
      if (ensureStyle() === null) return null
      if (ensureLayer() === null) return null
      return readSlots().then(function (payload) {
        var config = payload.config
        var slots = config.slots !== undefined && config.slots !== null ? config.slots : {}
        var group = slots[SLOT]
        var slot = group !== undefined && group !== null && typeof group === 'object' ? group : {}
        var options = config.options !== undefined && config.options !== null ? config.options : {}
        var bootGroup = options[SLOT]
        bootOptions = bootGroup !== undefined && bootGroup !== null && typeof bootGroup === 'object'
          ? bootGroup
          : {}
        // ★ THE HOLD BUDGET IS ARMED ONCE, AFTER THE OPTIONS WERE READ. A
        // budget that is re-armed on every re-evaluation never runs out.
        if (holdTimer === null) {
          holdTimer = globalThis.setTimeout(onHoldBudgetExpired, holdBudgetMs())
        }

        if (released === true) return null

        var enabled = slot.enabled === true
        var mediaId = typeof slot.mediaId === 'string' && slot.mediaId !== '' ? slot.mediaId : null
        var revision = typeof slot.revision === 'number' ? slot.revision : -1
        var pooled = sourceMode() === 'pool'
        // ★ THE POOL DOES NOT NEED A NAMED MATERIAL. The library IS the pool,
        // and the slot only has to say that the boot screen is on.
        if (enabled !== true || (mediaId === null && pooled === false)) {
          clipState = 'none'
          evaluated = true
          setCaption('没有配置片头素材 · ' + leaveHint(), false)
          maybeRelease()
          return null
        }

        // ★ THE MATERIAL IS APPLIED WHEN THE SETTING MOVED.
        if (revision === lastRevision && clipState === 'playing') return null
        if (revision === lastRevision && clipState === 'over') return null
        // ★ A FAILED MATERIAL IS NOT LOOKED UP AGAIN ON EVERY POLL. In click
        // mode the screen never leaves on its own, so a material that cannot
        // be played would be looked up again every second: the caption would
        // flicker between two texts and the media element would be created
        // and destroyed over and over.
        if (revision === lastRevision && clipState === 'failed') return null
        lastRevision = revision
        lastMediaId = mediaId

        // ★ WHILE THE MATERIAL IS BEING LOOKED UP, THE SCREEN IS NOT "EMPTY".
        // The kernel-ready exit must not fire in that window: the material may
        // be perfectly playable, and the library answer is only a moment away.
        if (clipState !== 'playing') clipState = 'loading'

        // ★ THE BOUNDED WAIT. The library is fetched with a window: a library
        // that never answers must not hold the viewport.
        if (catalogTimer !== null) globalThis.clearTimeout(catalogTimer)
        var catalogTimedOut = false
        catalogTimer = globalThis.setTimeout(function () {
          catalogTimer = null
          catalogTimedOut = true
          if (released === true) return
          if (clipState !== 'playing') {
            clipState = 'none'
            evaluated = true
            setCaption('素材清单没有回应 · ' + leaveHint(), false)
            maybeRelease()
          }
        }, CATALOG_WINDOW_MS)

        return readCatalog().then(function (catalog) {
          if (catalogTimedOut === true) return null
          if (catalogTimer !== null) {
            globalThis.clearTimeout(catalogTimer)
            catalogTimer = null
          }
          if (released === true) return null
          // ★ THE MATERIAL CANDIDATES. 'media' is the one material the slot
          // names; 'pool' is one out of the library, with the rest kept as
          // fallbacks.
          var candidates = resolveCandidates(catalog, mediaId)
          if (candidates.length === 0) {
            // ★ THE MATERIAL CANNOT BE RESOLVED ⇒ THAT IS A FAILURE, NOT A
            // "SKIP" — and the screen must not hold the viewport for it.
            lastResult = 'failed-kept-previous'
            clipState = 'none'
            evaluated = true
            setCaption((pooled === true ? '素材池是空的' : '素材库里找不到这一段') + ' · ' + leaveHint(), false)
            maybeRelease()
            return lastResult
          }
          var result = null
          var applied = null
          // ★ ONE MATERIAL THAT CANNOT BE PLAYED MUST NOT LEAVE THE SCREEN
          // ON A BARE GRADIENT WHILE THE LIBRARY STILL HOLDS USABLE ONES.
          for (var i = 0; i < candidates.length; i += 1) {
            result = applyEntry(candidates[i])
            if (result === 'applied') {
              applied = candidates[i]
              // ★ AND ONLY NOW IS THE PICK REMEMBERED. A pick that was
              // never shown is not a pick, and counting it would empty the
              // "not recently played" set for no reason.
              if (pooled === true && applied !== null && applied !== undefined) {
                // ★ THE HISTORY'S WINDOW IS THE POOL'S SIZE, NOT THE LIBRARY'S.
                //
                // The window is "how many of the last picks are remembered",
                // and the rule it serves is "the same material twice in a
                // row". A pool of two materials remembers ONE pick — the one
                // it must not repeat. A window sized by the whole library
                // would remember picks of materials that are not in the pool
                // at all, and the rule would fall apart exactly when the
                // pool is narrow.
                rememberPick(applied.id, candidates.length)
              }
              break
            }
          }
          if (result !== 'applied') {
            clipState = 'none'
            evaluated = true
            maybeRelease()
            return result
          }
          // ★ THE MATERIAL THAT IS REALLY ON THE STAGE. In pool mode that is
          // not the one the slot names.
          if (applied !== null && applied.id !== undefined) lastMediaId = applied.id
          clipState = 'playing'
          evaluated = true
          // ★ A NEW MATERIAL STARTS WITH A CLEAN SLATE.
          tailEntered = false
          frameShown = false
          setCaption(playingCaption(), false)
          // ★ THE TAIL DISSOLVE WATCHES THE MATERIAL'S OWN CLOCK.
          startTailWatch()
          return result
        })
      })
    }).catch(function (error) {
      warnOnce('读不到片头配置：' + String(error !== undefined && error !== null && error.message
        ? error.message
        : error))
      return null
    }).then(function (result) {
      busy = false
      return result
    })
  }

  /**
   * Whether the screen may go away.
   *
   * ★ THREE EXITS, AND NONE OF THEM TRAPS THE USER.
   *
   *   ① the material ended (or the upper bound expired);
   *   ② the material failed;
   *   ③ the kernel is ready and there is NOTHING TO SHOW.
   *
   * ③ is the one that is easy to get wrong: a boot screen with nothing to
   * play, waiting for a clip that will never come, is a screen that holds the
   * viewport forever.
   */
  function maybeRelease() {
    if (released === true) return
    // ★ CLICK MODE NEVER LEAVES ON ITS OWN. Every automatic exit asks this
    // first: the material is the show, and the user decides when it is over.
    if (mayEnterOnItsOwn() === false) {
      if (clipState !== 'failed') setCaption(leaveHint(), false)
      return
    }
    if (clipState === 'over') {
      // ★ THE SAME GATE AS THE END OF THE MATERIAL. The clip is over but
      // the application is not up yet: hold the last frame and wait for the
      // readiness signal. This is the path the readiness handler calls, so
      // the hand-over happens the moment the kernel is ready.
      // ★ THE WAIT IS ONLY FOR A KERNEL THAT IS STILL PENDING. A kernel that
      // FAILED will not become ready, and holding the viewport for it would
      // be a screen that never leaves — the application is never going to
      // arrive, so the boot screen has to give up and let it show whatever
      // it has.
      if (kernelReady !== true && kernelFailed !== true) {
        setCaption('启动较慢，就绪后自动进入', false)
        return
      }
      beginHandover('ended')
      return
    }
    if (clipState === 'failed') {
      beginHandover('failed')
      return
    }
    // ★ THE THIRD EXIT NEEDS BOTH FACTS: the kernel is ready, AND the surface
    // has looked and found nothing to show. Without the second one this would
    // fire before the material was even looked up.
    if (kernelReady === true && evaluated === true && clipState === 'none') {
      beginHandover('kernel-ready')
    }
  }

  /**
   * Wait for the Host's boot-readiness signal.
   *
   * ★ THE GLOBAL MAY NOT EXIST YET. This row lives in <head>, and the Host
   * creates the readiness deferred in a script at the end of the body ⇒ the
   * row usually runs FIRST. ⇒ the global is polled for, with a bound: a Host
   * that never creates it must not leave a timer running for the life of the
   * page.
   */
  function waitForKernel() {
    if (kernelReady === true || kernelFailed === true) return
    var attempts = 0
    var poll = function () {
      attempts += 1
      var gate = globalThis.__DSH_BOOT_READY__
      if (gate !== undefined && gate !== null && gate.promise !== undefined && gate.promise !== null) {
        kernelPollTimer = null
        var settled = false
        var done = function (ok) {
          if (settled === true) return
          settled = true
          if (kernelFailTimer !== null) {
            globalThis.clearTimeout(kernelFailTimer)
            kernelFailTimer = null
          }
          if (ok === true) {
            kernelReady = true
          } else {
            kernelFailed = true
          }
          reportFacts()
          maybeRelease()
        }
        // ★ A PROMISE THAT NEVER SETTLES IS AS BAD AS A GATE THAT NEVER
        // APPEARS.
        //
        // The poll below has a bound for the second case. This is the bound
        // for the first one: the deferred exists, it simply never resolves
        // and never rejects — and then the hand-over gates would wait for a
        // readiness signal that is never coming, and the boot screen would
        // stay on top of the viewport forever. Twenty seconds of silence is
        // not a slow start, it is an application that is not coming.
        kernelFailTimer = globalThis.setTimeout(function () { done(false) }, KERNEL_WAIT_MS)
        try {
          gate.promise.then(function () { done(true) }, function () { done(false) })
        } catch (error) {
          done(false)
        }
        return
      }
      if (attempts >= KERNEL_POLL_ATTEMPTS) {
        kernelPollTimer = null
        // ★ THE KERNEL NEVER ANSWERED. Twenty seconds of nothing is not a
        // slow start, it is an application that is not coming.
        //
        // ★ AND THIS MUST SET THE FLAG. Without it the hand-over gates keep
        // waiting for a readiness signal that is never coming, and the boot
        // screen stays on top of the viewport forever — a dead picture the
        // user cannot click through. "The kernel did not come" and "the
        // kernel failed" both mean the same thing to the gate: there is no
        // application to wait for, so the screen has to give up.
        kernelFailed = true
        reportFacts()
        maybeRelease()
        return
      }
      kernelPollTimer = globalThis.setTimeout(poll, KERNEL_POLL_MS)
    }
    poll()
  }

  /**
   * The surface's own state.
   * @returns the facts.
   */
  function state() {
    return {
      layer: layerElement !== null,
      media: mediaElement !== null,
      clip: clipState,
      kernelReady: kernelReady,
      kernelFailed: kernelFailed,
      released: released,
      yielded: yielded,
      mediaId: lastMediaId,
      revision: lastRevision,
      lastResult: lastResult,
      fadeMs: fadeMs(),
      holdMs: holdBudgetMs(),
      enterMode: enterMode(),
      source: sourceMode(),
      poolSize: poolIds().length,
      endlessMs: ENDLESS_MS,
    }
  }

  globalThis.__DSH_APPEARANCE_BOOT__ = {
    version: '0.1.0',
    available: arbitrationPoint() !== null,
    state: state,
    refresh: refresh,
    // ★ THE SAME PATH THE SURFACE ITSELF USES: the arbitration point does the
    // mounting, and the stage's host is registered for this slot ⇒ the
    // material lands inside the overlay.
    apply: function (entry) { return applyEntry(entry) },
    release: function () { beginHandover('manual') },
    // ★ THE END OF THE SURFACE. The stage goes clean and the host is
    // forgotten — the one thing a release does NOT do.
    dispose: function () {
      releaseBoot()
      unregisterMediaHost()
    },
  }

  // ★ THE SURFACE STARTS ONLY WITH AN ARBITRATION POINT.
  //
  // No arbitration point ⇒ no surface: the surface warns once and touches
  // nothing. It never becomes an arbitration point of its own.
  if (arbitrationPoint() === null) {
    warnOnce('没有仲裁点，片头表面不注册。')
  } else {
    ensureRunning()
    whenBodyReady().then(function () {
      ensureStyle()
      ensureLayer()
      ensureObserver()
      refresh()
    })
    waitForKernel()
  }
})()
