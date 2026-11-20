// dsh-appearance-media — the idle screensaver surface. INJECTED SIDE.
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
//   * the trigger is a fixed ORDER of seven conditions, and two of them are
//     ORed with each other;
//   * a hidden window is believed only after it has PERSISTED — the Electron
//     shell's `visibilityState` flickers while the window is plainly on
//     screen, and believing each flip strobed the whole screen;
//   * a dismissal HOLDS until the machine is seen to be in use again, so the
//     layer does not come back two seconds after the user clicked it away;
//   * the rotation swaps the material IN PLACE and dissolves between the two;
//   * the exit effect tears the picture apart instead of just fading it;
//   * the pointer decoration is caused by the pointer, and only while the
//     pointer is over the layer.
//
// ★ WHAT DID NOT COME WITH IT:
//
//   * its idle probe (`src/idle-probe.js`) — that one is Windows-only
//     (PowerShell + `user32.dll`), so on macOS it answered `unavailable`
//     forever. Ours is a Darwin `ioreg` reading, and it lives in the Host
//     half (`lib/probe.js` ⇒ `GET /appearance-media/system-idle.json`);
//   * its flat configuration — the upstream switches and numbers that hang off
//     the root of its settings document — ours is `slots.screensaver` +
//     `options.screensaver`, and the two models never coexist;
//   * its clip pools — ours is the material library;
//   * its materials — they are not ours to ship, and this package carries none.
//
// ★ THE MEDIA IS PLAYED BY THE ARBITRATION POINT.
//
// This surface owns the layer, the layer's lifetime and the trigger. The media
// is played through `controller.apply(SLOT, entry)`: the arbitration point owns
// the element, the state and the race handling. Two copies of "what is playing"
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
// ★ THE SCREENSAVER LOOPS.
//
// Its job is to cover the screen for an UNKNOWN length of time. A clip that
// stopped at its end would leave a frozen frame on a layer that is supposed to
// be there. ⇒ `loop` is decided by the arbitration point, per slot, and the
// screensaver slot's is `true`. (The boot slot's is `false`: its end IS the
// hand-over signal.)
//
// ★ THE TRIGGER IS SEVEN CONDITIONS, IN A FIXED ORDER.
//
//   ① the slot is not enabled              ⇒ never show
//   ② the user dismissed it and the machine has not been used again
//                                            ⇒ never show
//   ③ the boot clip is on the stage         ⇒ never show
//   ④ the page has been hidden for 5000 ms  ⇒ never show
//   ⑤ a conversation Turn is running        ⇒ never show
//   ⑥ an idle reading that is `ok` and at least the threshold ⇒ show
//   ⑦ the window has been out of focus for at least the threshold ⇒ show
//
// ⑥ and ⑦ are ORed with each other: neither alone covers what was asked for.
// ① … ⑤ are, in order, and the order is the contract.
//
// ★ THE IDLE READING HAS THREE STATES, AND TWO OF THEM ARE NOT IDLE.
//
// Only `ok` counts. `starting` means "ask again shortly" and `unavailable`
// means "never going to work here" — and a failure must never be flattened
// into `idleMs: 0`, because zero IS "the machine is being used right now" and
// the screen would then come up the instant the machine was touched.
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
// ★ THE RELEASE PLAYS NO EXIT EFFECT.
//
// The tear is part of the SHOW: it plays when the USER dismisses the layer, and
// the layer comes down first so the screen is clear immediately. What follows
// it — the release — is the teardown above, and it plays no effect of its own.
//
// ★ THE MARKER OF ANOTHER WALLPAPER PLUGIN IS READ, NEVER WRITTEN.
//
// When that plugin is on the stage this surface yields: the media, the layer
// and the injected style go away, and the WATCHER STAYS — so the screensaver
// can come back when the other plugin leaves. The slot's `enabled` flag is
// never touched: the user did not turn it off.
//
// ★ AND THE YIELDING USES `displace()`, NEVER `release()`.
//
// `release()` means "this slot will not play again" and it hands the stage over
// straight away — and the hand-over would drag a boot clip onto the screen at
// the exact moment another wallpaper plugin is taking over. `displace()` means
// "somebody else needs the stage for now": the material goes, the slot stays
// enabled, and the ARBITRATION POINT brings it back when the stage is free.
//
// ★ AND THE COMEBACK IS THE ARBITRATION POINT'S, NOT OURS.
//
// When the other plugin leaves, this surface calls `controller.restore()` and
// nothing else. The arbitration point applies its own priority
// (`boot > screensaver > background`), one slot at a time. A surface that
// decided that by itself would be a second rulebook, and two rulebooks
// disagree.
//
// ★ THE STAGE BEING EMPTY IS NOT A LOSS OF THE STAGE.
//
// The arbitration point publishes a change before anything has been applied,
// and at that moment nobody holds the stage. A surface that reads "the stage
// is not mine" as "somebody took it from me" tears its own layer down before
// it has ever shown anything — the screensaver would be built and torn down on
// every tick. ⇒ the flag says whether this surface put something on the stage.

/* eslint-disable */
;(function () {
  'use strict'

  /** The slot this surface owns. */
  var SLOT = 'screensaver'

  /** Where the slot configuration is read from. Always read live. */
  var SLOTS_URL = '/appearance-media/slots'

  /** Where the material library is read from. Always read live. */
  var CATALOG_URL = '/appearance-media/catalog.json'

  /** Where the machine's idle time is read from. Always read live. */
  var IDLE_URL = '/appearance-media/system-idle.json'

  /**
   * How long the page has to report itself hidden before it is believed.
   *
   * ★ PORTED. The Electron shell's `visibilityState` is not the stable signal
   * it is in a browser tab: it flips between `visible` and `hidden` while the
   * window is plainly on screen. Believing each flip showed and hid the layer
   * in turn, and the whole screen strobed. ⇒ a brief flip is ignored; a real
   * minimise still takes the layer down, a few seconds later.
   */
  var HIDDEN_GRACE_MS = 5000

  /** How often the trigger is evaluated, in milliseconds. */
  var CHECK_MS = 2000

  /** How long the layer takes to fade out, in milliseconds. */
  var FADE_MS = 250

  /**
   * How long a pointer has to be still before the layer stands down.
   *
   * ★ A POINTER MOVEMENT STANDS THE LAYER DOWN, BUT NOT INSTANTLY.
   *
   * The layer covers the screen for as long as the machine is idle, so a
   * nudged mouse has to end it. But a click is always PRECEDED by a movement,
   * and a click is the one dismissal that deserves the exit effect — so the
   * stand-down waits this long, and a click that arrives inside the window
   * cancels it and plays the tear instead.
   */
  var POINTER_SETTLE_MS = 350

  /** The threshold used when the configuration does not carry one. */
  var DEFAULT_IDLE_MS = 300000

  /** The bounded wait for the material library. */
  var CATALOG_WINDOW_MS = 10000

  /** The hint that tells the user how to get rid of the layer. */
  var HINT_TEXT = '点击或按任意键继续'

  /** The layer element: the surface's own element, mounted on the body. */
  var layerElement = null

  /** The stage element: the media is mounted into this. */
  var stageElement = null

  /** The hint element: the one line of text at the bottom. */
  var hintElement = null

  /** The style element: the layer's CSS. */
  var styleElement = null

  /** The media element the arbitration point mounted into the stage. */
  var mediaElement = null

  /** The observer that watches the body for the other plugin's marker. */
  var observer = null

  /** The poll timer, or null when it is not running. */
  var pollTimer = null

  /** The timer that lets a pointer movement stand the layer down. */
  var standDownTimer = null

  /** The timer that carries the cross-dissolve out. */
  var dissolveTimer = null

  /** The requestAnimationFrame handle of the cross-dissolve. */
  var dissolveFrame = null

  /** The timer that rotates the material. */
  var rotationTimer = null

  /** The timer that lets the hint fade out on its own. */
  var hintTimer = null

  /** The unsubscribe function of the arbitration point's subscription. */
  var offChange = null

  /** Whether the keyboard listener is bound. */
  var keyBound = false

  /** Whether the pointer-down listener is bound. */
  var pointerBound = false

  /** Whether the pointer-move listener is bound. */
  var pointerMoveBound = false

  /** Whether the window's blur/focus listeners are bound. */
  var focusBound = false

  /** Whether the visibility listener is bound. */
  var visibilityBound = false

  /** Whether this surface's host is registered with the arbitration point. */
  var hostRegistered = false

  /** The elements whose removal is deferred to the end of the current release. */
  var deferredRemovals = []

  /** Whether a release is in progress (the change events during it are ignored). */
  var releasing = false

  /** Whether the layer is on the screen right now. */
  var visible = false

  /**
   * Whether OUR material is on the stage right now.
   *
   * ★ THE STAGE IS EMPTY AT START-UP, AND THAT IS NOT A LOSS OF THE STAGE.
   */
  var materialApplied = false

  /** Whether another wallpaper plugin took the stage. */
  var yielded = false

  /** When the window last lost the focus, or null while it has it. */
  var blurredSince = null

  /** When the page last reported itself hidden, or null while it reports visible. */
  var hiddenSince = null

  /** The last idle reading, in milliseconds, or null when there is none. */
  var lastIdleMs = null

  /** The last idle reading's status: 'starting' | 'ok' | 'unavailable'. */
  var idleStatus = 'starting'

  /**
   * True from a dismissal until a FRESH, non-idle reading has been seen.
   *
   * ★ THE GUARD IS A LATCH, NOT A TIMER. It clears on EVIDENCE — a reading
   * that says the machine is in use — rather than on a guess about how long
   * that takes.
   */
  var dismissedUntilActive = false

  /** Whether a real input happened since the dismissal. */
  var activitySinceDismiss = false

  /** The id of the material that was applied. */
  var lastMediaId = null

  /** The slot revision of the material that was applied. */
  var lastRevision = -1

  /** The options of the screensaver, as they were read last. */
  var lastOptions = {}

  /** The catalog's entries, as they were read last. */
  var lastCatalogEntries = []

  /** What the last apply answered. */
  var lastResult = null

  /** The verdict of the last trigger evaluation. */
  var lastVerdict = null

  /** Whether a re-evaluation is already running. */
  var busy = false

  /** Whether the missing-arbitration-point warning was already printed. */
  var warned = false

  /** The pointer decoration, or null when there is none. */
  var pointerArt = null

  /** Whether the surface has been torn down for good. */
  var destroyed = false

  /* ------------------------------------------------------------- helpers */

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
   * ★ THIS IS A READ. The markers belong to the other plugins: they are
   * read, they are never written, and they are never removed.
   *
   * ★ TWO MARKERS, TWO PLUGINS — the same two the background surface
   * checks:
   *
   *   `data-we-wallpaper` on the BODY — the public convention of the
   *   wallpaper plugin that ships with this host;
   *   `data-dsvs-background` on the ROOT element — the read-only marker the
   *   other wallpaper plugin exposes for others to avoid it.
   *
   * ★ The screensaver stands on the same stage as the background, so it has
   * to yield for the same reasons.
   *
   * @returns true when the other plugin holds the stage.
   */
  function anotherWallpaperIsOnStage() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return false
    var body = doc.body
    if (body !== undefined && body !== null && typeof body.getAttribute === 'function') {
      var value = body.getAttribute('data-we-wallpaper')
      if (value !== undefined && value !== null && String(value) !== '') return true
    }
    var root = doc.documentElement
    if (root !== undefined && root !== null && typeof root.getAttribute === 'function') {
      var other = root.getAttribute('data-dsvs-background')
      if (other !== undefined && other !== null && String(other) !== '') return true
    }
    return false
  }

  /**
   * Whether the boot clip is on the stage.
   *
   * ★ THE ARBITRATION POINT'S OWN TRUTH IS THE AUTHORITY. The boot surface's
   * own fact is a second opinion, and it is only consulted when the
   * arbitration point cannot answer.
   *
   * @returns true when the boot clip holds the stage.
   */
  function bootIsOnStage() {
    var controller = arbitrationPoint()
    if (controller !== null && typeof controller.state === 'function') {
      try {
        var snapshot = controller.state()
        if (snapshot !== undefined && snapshot !== null && snapshot.slot === 'boot') return true
      } catch (error) {
        /* the arbitration point's truth is best effort */
      }
    }
    var boot = globalThis.__DSH_APPEARANCE_BOOT__
    if (boot !== undefined && boot !== null && typeof boot.state === 'function') {
      try {
        var facts = boot.state()
        if (facts !== undefined && facts !== null && facts.layer === true) return true
      } catch (error) {
        /* the boot surface's own fact is best effort */
      }
    }
    return false
  }

  /**
   * Whether the user asked their system for reduced motion.
   *
   * @returns true when the motion should be kept plain.
   */
  function prefersReducedMotion() {
    try {
      var matcher = globalThis.matchMedia
      if (typeof matcher !== 'function') return false
      var query = matcher('(prefers-reduced-motion: reduce)')
      return query !== undefined && query !== null && query.matches === true
    } catch (error) {
      return false
    }
  }

  /**
   * A number, or null.
   *
   * @param value - the value.
   * @returns the number, or null.
   */
  function numberOrNull(value) {
    return typeof value === 'number' && isFinite(value) ? value : null
  }

  /**
   * A number, or zero.
   *
   * @param value - the value.
   * @returns the number, or zero.
   */
  function numberOrZero(value) {
    var found = numberOrNull(value)
    return found === null ? 0 : found
  }

  /**
   * The current time, in milliseconds.
   *
   * @returns the time.
   */
  function now() {
    var perf = globalThis.performance
    if (perf !== undefined && perf !== null && typeof perf.now === 'function') return perf.now()
    return Date.now()
  }

  /**
   * Print a warning once.
   *
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
   *
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

  /* ----------------------------------------------------------- the trigger */

  /**
   * The idle threshold, in milliseconds.
   *
   * ★ THE VALUE IS READ AT RUNTIME. The user changed it one second ago and
   * the change is already in effect — the configuration is fetched on every
   * evaluation, and never baked into this text.
   *
   * @param group - the screensaver's options.
   * @returns the threshold.
   */
  function idleThresholdMs(group) {
    var options = group !== undefined && group !== null && typeof group === 'object' ? group : {}
    var value = options.idleMs
    if (typeof value === 'number' && isFinite(value) && value >= 30000 && value <= 3600000) {
      return Math.round(value)
    }
    return DEFAULT_IDLE_MS
  }

  /**
   * How long the window has been out of focus, in milliseconds.
   *
   * @returns the duration, or zero while the window has the focus.
   */
  function blurredFor() {
    if (blurredSince === null) return 0
    return Math.max(0, Date.now() - blurredSince)
  }

  /**
   * How long the page has reported itself hidden, in milliseconds.
   *
   * @returns the duration, or zero while it reports itself visible.
   */
  function hiddenFor() {
    if (hiddenSince === null) return 0
    return Math.max(0, Date.now() - hiddenSince)
  }

  /**
   * Whether the page is hidden right now.
   *
   * @returns true when the page is hidden.
   */
  function pageIsHidden() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return false
    if (doc.visibilityState === 'hidden') return true
    return doc.hidden === true
  }

  /**
   * Whether a conversation Turn is still running.
   *
   * ★ PORTED. A running Turn is the page showing work in progress: covering it
   * would hide the answer the user is waiting for. `[data-holding]` is the
   * idle twin of the marker — after a Turn's content is complete the row stays
   * mounted, hidden, until the actions row replaces it — so a holding row must
   * not count as running.
   *
   * Presence-only, and never an error: the chat UI is a different package that
   * may change its DOM, and a throwing check here would take the whole
   * screensaver down with it.
   *
   * @returns true when a Turn is running.
   */
  function chatTurnRunning() {
    try {
      var doc = globalThis.document
      if (doc === undefined || doc === null) return false
      if (typeof doc.querySelector !== 'function') return false
      return doc.querySelector('[data-chat-running]:not([data-holding])') !== null
    } catch (error) {
      return false
    }
  }

  /**
   * THE TRIGGER.
   *
   * ★ ONE PURE FUNCTION, AND IT IS THE WHOLE RULE.
   *
   * Everything the live path knows is put into `readings`, and this function
   * turns those readings into the answer. That is deliberate: the rule is
   * then one function that can be driven with made-up readings, and the live
   * path and the test drive the SAME code — a test that exercised a copy of
   * the rule would be testing the copy.
   *
   * The order is the contract, and it is the upstream plugin's order:
   *
   *   ① the slot is not enabled;
   *   ② the user dismissed it and the machine has not been used again;
   *   ③ the boot clip is on the stage;
   *   ④ the page has been hidden for the grace period;
   *   ⑤ a Turn is running;
   *   ⑥ an idle reading that is `ok` and at least the threshold;
   *   ⑦ the window has been out of focus for at least the threshold.
   *
   * ⑥ and ⑦ are ORed: neither alone covers what was asked for.
   *
   * @param readings - the readings.
   * @returns `{ show, blockedBy }`.
   */
  function decide(readings) {
    var r = readings !== undefined && readings !== null && typeof readings === 'object' ? readings : {}
    // ① the slot is off.
    if (r.enabled !== true) return { show: false, blockedBy: 'disabled' }
    // ② a dismissal holds until the machine is seen to be in use again.
    if (r.dismissed === true) return { show: false, blockedBy: 'dismissed' }
    // ③ the boot clip owns the screen until it hands over.
    if (r.bootOnStage === true) return { show: false, blockedBy: 'boot-on-stage' }
    // ④ a window nobody can see should not be covered — once the reading has
    //    PERSISTED.
    if (numberOrZero(r.hiddenMs) >= HIDDEN_GRACE_MS) return { show: false, blockedBy: 'hidden' }
    // ⑤ a Turn that is still running holds the screen for the user.
    if (r.turnRunning === true) return { show: false, blockedBy: 'turn-running' }
    var threshold = numberOrZero(r.thresholdMs)
    if (threshold <= 0) threshold = DEFAULT_IDLE_MS
    // ⑥ THE OS HALF. ONLY AN `ok` READING COUNTS: `starting` means the probe
    //    has not answered yet and `unavailable` means it never will, so
    //    neither may be read as "idle".
    if (r.idleStatus === 'ok') {
      var idle = numberOrNull(r.idleMs)
      if (idle !== null && idle >= threshold) return { show: true, blockedBy: null }
    }
    // ⑦ THE FOCUS HALF. Always available, and the only half on a machine
    //    whose idle counter cannot be read.
    if (numberOrZero(r.blurredMs) >= threshold) return { show: true, blockedBy: null }
    return { show: false, blockedBy: 'not-idle' }
  }

  /**
   * Gather the readings the trigger needs.
   *
   * @param config - the slot configuration, as it was read.
   * @returns the readings.
   */
  function collectReadings(config) {
    var slots = config !== undefined && config !== null && typeof config === 'object'
      && config.slots !== undefined && config.slots !== null ? config.slots : {}
    var group = slots[SLOT]
    var slot = group !== undefined && group !== null && typeof group === 'object' ? group : {}
    var options = config !== undefined && config !== null && typeof config === 'object'
      && config.options !== undefined && config.options !== null ? config.options : {}
    var own = options[SLOT]
    var ownOptions = own !== undefined && own !== null && typeof own === 'object' ? own : {}
    return {
      enabled: slot.enabled === true,
      dismissed: dismissedUntilActive === true,
      bootOnStage: bootIsOnStage(),
      hiddenMs: Math.round(hiddenFor()),
      turnRunning: chatTurnRunning(),
      idleStatus: idleStatus,
      idleMs: lastIdleMs,
      thresholdMs: idleThresholdMs(ownOptions),
      blurredMs: Math.round(blurredFor()),
    }
  }

  /* --------------------------------------------------------- the live data */

  /**
   * Read the slot configuration.
   *
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
   *
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
   * Find one entry in the material library.
   *
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
   * Turn a media id into the library entry that carries the media URL.
   *
   * ★ THE ARBITRATION POINT REMEMBERS IDS, NOT URLS. It asks the surface that
   * owns the slot, and the surface answers with the entry the library
   * published — the URL is never built by hand.
   *
   * ★ AND THE ANSWER IS THE CURRENT ONE. The library is read again every
   * time, so a hand-over gives back the material that is in the library NOW.
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
   * Read the machine's idle time and fold it in.
   *
   * ★ THE READING IS NOT AWAITED BY THE TRIGGER. The trigger decides with
   * the reading it has in hand, and the new one arrives afterwards. That is
   * what makes a dismissal stick: the poll that runs right after the click
   * still holds the OLD reading, which still says "idle", and the layer would
   * come back without the latch.
   *
   * ★ A FAILED READ SAYS NOTHING ABOUT THE USER. The previous reading stays
   * where it is, rather than being replaced by a guess.
   *
   * @returns a promise for the answer, or null.
   */
  function pollIdle() {
    var fetcher = globalThis.fetch
    if (typeof fetcher !== 'function') return Promise.resolve(null)
    return Promise.resolve(fetcher(IDLE_URL, { cache: 'no-store' })).then(function (response) {
      if (response === undefined || response === null || response.ok !== true) return null
      return response.json()
    }).then(function (payload) {
      if (payload === null || typeof payload !== 'object') return null
      applyIdleReading(payload)
      return payload
    }).catch(function (error) {
      return null
    })
  }

  /**
   * Fold one idle reading in.
   *
   * @param payload - the reading.
   */
  function applyIdleReading(payload) {
    var status = typeof payload.status === 'string' ? payload.status : 'unavailable'
    idleStatus = status
    // ★ `idleMs` IS A NUMBER ONLY WHEN THE STATUS IS `ok`. A failed reading
    // is not a zero — a zero says "the machine is being used right now".
    lastIdleMs = status === 'ok' ? numberOrNull(payload.idleMs) : null
    // ★ A READING THAT SAYS THE MACHINE IS IN USE IS THE EVIDENCE THAT CLEARS
    // A DISMISSAL.
    if (idleStatus === 'ok' && lastIdleMs !== null && lastIdleMs < idleThresholdMs(lastOptions)) {
      dismissedUntilActive = false
      activitySinceDismiss = false
      return
    }
    // ★ AND WHEN THE PROBE CANNOT SAY ANYTHING, THE PAGE'S OWN EVIDENCE
    // COUNTS: a real input happened, and the window has the focus.
    if (idleStatus !== 'ok' && activitySinceDismiss === true && blurredFor() === 0) {
      dismissedUntilActive = false
      activitySinceDismiss = false
    }
  }

  /* ------------------------------------------------------------- the layer */

  /**
   * The CSS of the layer.
   *
   * ★ THE MEDIA RULES ARE SCOPED UNDER THE LAYER.
   *
   * Every media element carries the same class, and the other surfaces use it
   * too ⇒ a rule on the class itself would restyle their media as well.
   *
   * ★ AND THE LAYER STATES ITS OWN VISIBILITY RULE FOR THE MEDIA. The boot
   * screen's sheet is injected AFTER this one and holds its media at
   * `opacity: 0` until it hands over; the descendant form below outranks that
   * single-class rule, so the screensaver never depends on the boot screen
   * still being around to show its picture.
   *
   * ★ NO ATTRIBUTE SELECTORS. The states are classes, so nothing depends on
   * the CSS parser accepting `[data-shown=1]`.
   *
   * @returns the CSS text.
   */
  function styles() {
    return [
      '.dsham-saver-layer{position:fixed;inset:0;z-index:2147483647;overflow:hidden;',
      'background:#050b14;opacity:0;transition:opacity .25s ease;',
      'display:none;visibility:hidden;pointer-events:none;',
      '-webkit-user-select:none;user-select:none;}',
      '.dsham-saver-layer.is-shown{display:block;visibility:visible;opacity:1;pointer-events:auto;}',
      '.dsham-saver-layer.is-leaving{display:block;visibility:visible;opacity:0;pointer-events:none;}',
      '.dsham-saver-stage{position:absolute;inset:0;}',
      '.dsham-saver-layer .dsham-media{position:absolute;inset:0;width:100%;height:100%;',
      'object-fit:cover;opacity:1;}',
      '.dsham-saver-layer .dsham-media canvas{opacity:1;}',
      '.dsham-saver-hint{position:absolute;left:50%;bottom:40px;transform:translateX(-50%);',
      'z-index:4;font:12px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
      'letter-spacing:.14em;color:rgba(233,241,250,.9);',
      'background:rgba(8,14,24,.55);border:1px solid rgba(160,190,220,.22);',
      'border-radius:999px;padding:7px 16px;',
      'white-space:nowrap;pointer-events:none;transition:opacity .5s ease;}',
      '.dsham-saver-hint.is-quiet{opacity:0;}',
      '.dsham-saver-hint.is-hidden{display:none;}',
      '.dsham-saver-dissolve{position:absolute;inset:0;width:100%;height:100%;',
      'pointer-events:none;z-index:2;}',
      '.dsham-saver-pointer{position:absolute;inset:0;width:100%;height:100%;',
      'pointer-events:none;z-index:3;}',
      '.dsham-saver-tear{position:fixed;inset:0;z-index:2147483647;pointer-events:none;}',
      '@media (prefers-reduced-motion: reduce){.dsham-saver-layer{transition:opacity .2s ease;}}',
    ].join('\n')
  }

  /**
   * Put the style element on the page.
   *
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
    element.textContent = styles()
    parent.appendChild(element)
    styleElement = element
    return styleElement
  }

  /**
   * Put the layer on the page.
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
    layer.className = 'dsham-saver-layer'
    var stage = doc.createElement('div')
    stage.className = 'dsham-saver-stage'
    var hint = doc.createElement('div')
    hint.className = 'dsham-saver-hint'
    hint.textContent = HINT_TEXT
    layer.appendChild(stage)
    layer.appendChild(hint)
    body.appendChild(layer)
    layerElement = layer
    stageElement = stage
    hintElement = hint
    // ★ THE LAYER TAKES THE CLICK. The media inside it refuses the pointer,
    // so the click always reaches the layer.
    if (typeof layer.addEventListener === 'function') {
      layer.addEventListener('pointerdown', onPointerDown)
      pointerBound = true
    }
    return layerElement
  }

  /**
   * Put the layer into one of its three states.
   *
   * @param state - 'hidden' | 'shown' | 'leaving'.
   */
  function setLayerState(state) {
    if (layerElement === null) return
    var suffix = state === 'shown' ? ' is-shown' : (state === 'leaving' ? ' is-leaving' : '')
    try {
      layerElement.className = 'dsham-saver-layer' + suffix
    } catch (error) {
      /* the layer does not have a class name */
    }
  }

  /**
   * Show or hide the hint.
   *
   * @param visible - whether the hint should be on screen.
   */
  function setHintVisible(visible) {
    if (hintElement === null) return
    try {
      hintElement.className = 'dsham-saver-hint'
        + (visible ? '' : ' is-hidden')
    } catch (error) {
      /* the hint does not have a class name */
    }
  }

  /**
   * Put the layer's opacity back.
   *
   * ★ THE STAGE IS HANDED OVER CLEAN. Whatever happened to the layer's
   * opacity — a fade that was interrupted, a tear that came down — it is put
   * back before the element goes, so a layer that is built again never starts
   * transparent.
   */
  function restoreOpacity() {
    if (layerElement === null) return
    try {
      layerElement.style.opacity = '1'
    } catch (error) {
      /* the layer does not have a style object */
    }
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

  /* ----------------------------------------------------------------- host */

  /**
   * The host interface the arbitration point uses for THIS slot.
   *
   * The element lands inside the stage, and it leaves the page during the
   * LAST step of a release — not before the observer and the timers are done.
   *
   * ★ IT ALSO CARRIES `ensure()` AND `resolve()`.
   *
   *   `ensure()`   make sure the layer is there. The arbitration point asks
   *                before it mounts, because a release takes the layer away.
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
        // ★ A MOUNT MEANS OUR MATERIAL IS ON THE STAGE. The arbitration point
        // may apply it on its own — that is how a pushed-off slot comes back —
        // and then the layer has to come up with it, or the material would
        // play behind an invisible layer.
        materialApplied = true
        visible = true
        if (layerElement !== null) {
          setLayerState('shown')
          try {
            layerElement.style.opacity = '1'
          } catch (error) {
            /* the layer does not have a style object */
          }
        }
        // ★ THE MEDIA IS POSITIONED BY ITSELF, NOT ONLY BY THE STYLE SHEET.
        try {
          element.style.position = 'absolute'
          element.style.inset = '0px'
          element.style.width = '100%'
          element.style.height = '100%'
          element.style.objectFit = 'cover'
          element.style.pointerEvents = 'none'
          // ★ THE MEDIA IS VISIBLE. The boot screen's own sheet holds its media
          // at `opacity: 0` until it hands over, and this element is built by
          // the same adapter.
          element.style.opacity = '1'
        } catch (error) {
          /* the element does not have a style object */
        }
        var target = stageElement
        if (target === undefined || target === null) return
        target.appendChild(element)
        applyVolume(element)
      },
      unmount: function (element) {
        // ★ A SWITCHED MATERIAL LEAVES THE PAGE RIGHT NOW. Only a release
        // defers the removal: there the contract puts "remove the elements"
        // last, after the observer and the timers are done.
        if (releasing !== true) {
          removeElement(element)
          return
        }
        deferredRemovals.push(element)
      },
      // ★ MAKE SURE THE LAYER IS THERE.
      ensure: function () {
        if (ensureStyle() === null) return null
        if (ensureLayer() === null) return null
        return true
      },
      // ★ THE ENTRY COMES FROM THE LIBRARY, NEVER FROM A HAND-WRITTEN URL.
      resolve: function (mediaId) { return resolveEntry(mediaId) },
    }
  }

  /**
   * Register this surface's host with the arbitration point, for its slot.
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
   * registration: the surface can be asked for its layer again.
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

  /* ------------------------------------------------------------- the media */

  /**
   * The volume the media should play at.
   *
   * ★ PORTED. `video.volume` is a LINEAR amplitude multiplier; loudness is
   * roughly logarithmic, so a linear slider spends almost all of its travel in
   * a range that sounds nearly identical, and its bottom end cannot get quiet.
   * A square is the cheapest curve that fixes it.
   *
   * @param position - the slider position, 0..1.
   * @returns the gain, 0..1.
   */
  function volumeToGain(position) {
    var p = typeof position === 'number' && isFinite(position)
      ? Math.min(1, Math.max(0, position))
      : 0
    return p * p
  }

  /**
   * Put the configured level onto the media element.
   *
   * ★ THE ARBITRATION POINT OWNS THE AUDIO, and it maps the volume
   * linearly. This is the perceptual correction on top of that, applied when
   * the element is mounted. ⇒ a later options change is answered by the
   * arbitration point's own linear level (see docs/DETAIL.md, known limits).
   *
   * @param element - the media element.
   */
  function applyVolume(element) {
    if (element === undefined || element === null) return
    var options = lastOptions !== null && typeof lastOptions === 'object' ? lastOptions : {}
    var gain = volumeToGain(options.volume)
    try {
      if (typeof element.volume === 'number') element.volume = gain
    } catch (error) {
      /* the element does not have a volume */
    }
  }

  /**
   * Take the media off the page.
   *
   * ★ TWO DIFFERENT MEANINGS, TWO DIFFERENT CALLS.
   *
   * A release says "this slot will not play again". A displacement says
   * "somebody else needs the stage for now" — the slot stays enabled and the
   * arbitration point brings it back. ⇒ THE YIELDING PATH MUST NOT USE
   * `release()`: `release()` hands the stage over right away, and the
   * hand-over would drag a boot clip onto the screen at the exact moment
   * another wallpaper plugin is taking over.
   *
   * @param displaced - true when the slot is being pushed off the stage.
   */
  function releaseMedia(displaced) {
    var controller = arbitrationPoint()
    if (controller === null) return
    if (displaced === true && typeof controller.displace === 'function') {
      try {
        controller.displace(SLOT)
        return
      } catch (error) {
        /* the arbitration point does not know about displacements */
      }
    }
    try {
      controller.release(SLOT)
    } catch (error) {
      /* the release is best effort */
    }
  }

  /**
   * Play one entry.
   *
   * @param entry - the library entry.
   * @returns what the arbitration point answered.
   */
  function applyEntry(entry) {
    var controller = arbitrationPoint()
    if (controller === null) {
      warnOnce('没有仲裁点，屏保表面不注册。')
      return 'no-arbitration-point'
    }
    // ★ THE ELEMENTS THAT WAITED FOR THEIR TURN GO NOW. A material that was
    // released while nobody was looking must not pile up in the layer.
    flushDeferredRemovals()
    // ★ THE ARBITRATION POINT IS THE ONLY PATH TO THE MEDIA — and it asks
    // this surface for its host first, so the layer is there and the element
    // lands inside the stage.
    var result = controller.apply(SLOT, entry)
    lastResult = typeof result === 'string' ? result : 'applied'
    if (lastResult === 'applied') materialApplied = true
    reportFacts()
    return lastResult
  }

  /* ------------------------------------------------------------ appearing */

  /**
   * Bring the layer up.
   *
   * ★ THE LAYER COMES UP FIRST, BEFORE THE MATERIAL. The material is fetched
   * after the layer is on the screen: a visible layer must not wait on the
   * network before it finishes coming up, and a library that never answers
   * must not keep the screen empty.
   *
   * @param slot - the screensaver's slot configuration.
   * @param options - the screensaver's options.
   * @returns a promise for what happened.
   */
  function showScreensaver(slot, options) {
    if (visible) return Promise.resolve(null)
    visible = true
    lastOptions = options
    if (ensureStyle() === null) {
      visible = false
      return Promise.resolve(null)
    }
    if (ensureLayer() === null) {
      visible = false
      return Promise.resolve(null)
    }
    setLayerState('shown')
    try {
      layerElement.style.opacity = '1'
    } catch (error) {
      /* the layer does not have a style object */
    }
    // ★ THE HINT IS BUILT ALWAYS AND HIDDEN BY A RULE, so the DOM shape does
    // not change when the setting does.
    setHintVisible(options.hint !== false)
    var mediaId = typeof slot.mediaId === 'string' && slot.mediaId !== '' ? slot.mediaId : null
    lastRevision = typeof slot.revision === 'number' ? slot.revision : -1
    if (mediaId === null) {
      visible = false
      standDown('no-material')
      return Promise.resolve('no-material')
    }
    lastMediaId = mediaId
    var catalogTimedOut = false
    var catalogTimer = globalThis.setTimeout(function () {
      catalogTimedOut = true
      if (visible === false) return
      standDown('catalog-timeout')
    }, CATALOG_WINDOW_MS)
    return readCatalog().then(function (catalog) {
      if (catalogTimedOut === true) return null
      globalThis.clearTimeout(catalogTimer)
      if (visible === false) return null
      lastCatalogEntries = Array.isArray(catalog.entries) ? catalog.entries : []
      var entry = findEntry(lastCatalogEntries, mediaId)
      if (entry === null) {
        lastResult = 'failed-kept-previous'
        standDown('no-material')
        return lastResult
      }
      var result = applyEntry(entry)
      if (result !== 'applied') {
        standDown('apply-failed')
        return result
      }
      startPointerArt(options)
      startRotation(options)
      return result
    }).catch(function (error) {
      globalThis.clearTimeout(catalogTimer)
      warnOnce('读不到素材库：' + String(error !== undefined && error !== null && error.message
        ? error.message
        : error))
      standDown('catalog-failed')
      return null
    })
  }

  /* ------------------------------------------------------------- standing */

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
   * Clear the timers that belong to an appearance.
   */
  function clearAppearanceTimers() {
    if (standDownTimer !== null) {
      globalThis.clearTimeout(standDownTimer)
      standDownTimer = null
    }
    if (dissolveTimer !== null) {
      globalThis.clearTimeout(dissolveTimer)
      dissolveTimer = null
    }
    if (dissolveFrame !== null) {
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(dissolveFrame)
      }
      dissolveFrame = null
    }
    if (rotationTimer !== null) {
      globalThis.clearTimeout(rotationTimer)
      rotationTimer = null
    }
    if (hintTimer !== null) {
      globalThis.clearTimeout(hintTimer)
      hintTimer = null
    }
  }

  /**
   * The release.
   *
   * ★ THE ORDER IS THE CONTRACT:
   *
   *   pause → clear the source → unbind the listeners → disconnect the
   *        observer → clear the timers → remove the elements
   *
   * The media's own teardown belongs to the adapter, and the arbitration point
   * calls it. This surface adds its own steps around it and removes the
   * elements LAST.
   *
   * @param full - true when the surface itself ends (the watcher goes too);
   *   false when only the appearance goes (the watcher stays, so the layer can
   *   come back).
   * @param displaced - true when the slot is being pushed off the stage
   *   rather than released for good.
   */
  function releaseScreensaver(full, displaced) {
    // ★ ONE RELEASE AT A TIME. The arbitration point publishes a change while
    // it releases, and that change must not start a second teardown in the
    // middle of this one.
    if (releasing === true) return
    releasing = true
    try {
      // ① the media: pause → clear the source → unbind its listeners.
      releaseMedia(displaced === true)
      // ② this surface's own listeners.
      if (full === true) {
        if (offChange !== null) {
          try { offChange() } catch (error) { /* the subscription is best effort */ }
          offChange = null
        }
        unbindWindowListeners()
      }
      // ③ the observer.
      if (full === true) {
        if (observer !== null) {
          try { observer.disconnect() } catch (error) { /* the observer is best effort */ }
          observer = null
        }
      }
      // ④ the timers.
      if (full === true) {
        if (pollTimer !== null) {
          if (typeof globalThis.clearInterval === 'function') globalThis.clearInterval(pollTimer)
          pollTimer = null
        }
      }
      clearAppearanceTimers()
      // ⑤ the elements — LAST. The pointer canvas is one of ours, so it goes
      // in this phase too.
      stopPointerArt()
      flushDeferredRemovals()
      restoreOpacity()
      removeElement(layerElement)
      removeElement(styleElement)
      layerElement = null
      stageElement = null
      hintElement = null
      styleElement = null
      mediaElement = null
      materialApplied = false
      visible = false
      // ★ THE HOST IS NOT FORGOTTEN. A release takes the LAYER away, and the
      // layer is built again when the next material asks for it — the host's
      // `ensure()` does that.
    } finally {
      releasing = false
    }
    reportFacts()
  }

  /**
   * The layer goes down without anybody asking for it.
   *
   * ★ THE WATCHER STAYS. The layer has to be able to come back, and only the
   * appearance goes: the media, the layer, the style and the appearance's own
   * timers.
   *
   * @param reason - why.
   * @param displaced - true when the slot is being pushed off the stage.
   */
  function standDown(reason, displaced) {
    lastVerdict = { show: false, blockedBy: reason }
    if (layerElement === null && mediaElement === null && visible === false) return
    releaseScreensaver(false, displaced === true)
  }

  /**
   * The user dismissed the layer.
   *
   * ★ THE DISMISSAL HOLDS. The layer must not come back until the machine is
   * seen to be in use again — otherwise it comes back about two seconds after
   * the user clicked it away, on the reading the poll was already holding.
   */
  function dismiss() {
    if (visible === false) return
    dismissedUntilActive = true
    activitySinceDismiss = false
    if (standDownTimer !== null) {
      globalThis.clearTimeout(standDownTimer)
      standDownTimer = null
    }
    var options = lastOptions !== null && typeof lastOptions === 'object' ? lastOptions : {}
    if (options.breakEffect === true && prefersReducedMotion() !== true) {
      // ★ THE TEAR PLAYS, AND THE LAYER COMES DOWN FIRST, so the screen is
      // clear immediately whatever the effect costs.
      playBreakEffect(breakStyleOf(options))
      return
    }
    fadeOutAndRelease()
  }

  /**
   * The layer fades out and is released.
   */
  function fadeOutAndRelease() {
    if (layerElement === null) {
      releaseScreensaver(false, false)
      return
    }
    setLayerState('leaving')
    try {
      layerElement.style.transitionDuration = (FADE_MS / 1000) + 's'
      layerElement.style.opacity = '0'
    } catch (error) {
      /* the layer does not have a style object */
    }
    if (standDownTimer !== null) globalThis.clearTimeout(standDownTimer)
    standDownTimer = globalThis.setTimeout(function () {
      standDownTimer = null
      if (visible === false) return
      releaseScreensaver(false, false)
    }, FADE_MS + 60)
  }

  /* ---------------------------------------------------------- the yielding */

  /**
   * Hand the stage to the other wallpaper plugin.
   *
   * ★ THE STAGE GOES CLEAN: the media, the layer and the injected style all
   * go. The other plugin cleans up after itself, and it must not find our
   * leftovers.
   *
   * ★ THE WATCHER STAYS. The observer, the poll and the subscription are the
   * ears that hear the other plugin leave the stage again.
   *
   * ★ AND THE SLOT IS NOT TOUCHED. The user did not turn the screensaver off.
   */
  function yieldStage() {
    if (yielded === true) return
    yielded = true
    // ★ THE QUIET RELEASE, WITH A DISPLACEMENT. The slot was pushed off, not
    // turned off, and the arbitration point brings it back.
    releaseScreensaver(false, true)
  }

  /**
   * The other plugin left the stage.
   *
   * ★ ONE ROAD FOR THE COMEBACK — THE ARBITRATION POINT'S. The surface does
   * not decide who comes back and in which order: the arbitration point
   * does, with its own priority list. A surface that decided that by itself
   * would be a second rulebook, and two rulebooks disagree.
   */
  function restoreAfterYield() {
    yielded = false
    var controller = arbitrationPoint()
    if (controller !== null && typeof controller.restore === 'function') {
      try {
        // ★ AND NOTHING ELSE. The arbitration point re-reads the configuration
        // and applies its own priority list; a second evaluation from here
        // would be a second rulebook, and it could apply the material this
        // surface is not supposed to apply.
        controller.restore()
        return
      } catch (error) {
        /* the arbitration point does not know about restorations */
      }
    }
    evaluate()
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
      // ★ THE OTHER PLUGIN CLAIMED THE STAGE ⇒ THIS SURFACE GOES AWAY.
      if (anotherWallpaperIsOnStage()) {
        yieldStage()
        return
      }
      // ★ THE OTHER PLUGIN LEFT THE STAGE ⇒ THE ARBITRATION POINT DECIDES
      // WHO COMES BACK.
      if (yielded === true) restoreAfterYield()
    })
    try {
      observer.observe(body, { attributes: true })
    } catch (error) {
      observer = null
    }
  }

  /* ---------------------------------------------------------- the listeners */

  /**
   * Bind the window's own listeners.
   */
  function bindWindowListeners() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return
    var win = globalThis.window
    if (focusBound !== true && win !== undefined && win !== null
      && typeof win.addEventListener === 'function') {
      win.addEventListener('blur', onWindowBlur)
      win.addEventListener('focus', onWindowFocus)
      focusBound = true
    }
    if (visibilityBound !== true && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange)
      visibilityBound = true
    }
    if (keyBound !== true && typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', onKeyDown)
      keyBound = true
    }
    if (pointerMoveBound !== true && typeof doc.addEventListener === 'function') {
      doc.addEventListener('mousemove', onMouseMove)
      pointerMoveBound = true
    }
  }

  /**
   * Unbind the window's own listeners.
   */
  function unbindWindowListeners() {
    var doc = globalThis.document
    var win = globalThis.window
    if (focusBound === true && win !== undefined && win !== null
      && typeof win.removeEventListener === 'function') {
      win.removeEventListener('blur', onWindowBlur)
      win.removeEventListener('focus', onWindowFocus)
    }
    focusBound = false
    if (visibilityBound === true && doc !== undefined && doc !== null
      && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibilityChange)
    }
    visibilityBound = false
    if (keyBound === true && doc !== undefined && doc !== null
      && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('keydown', onKeyDown)
    }
    keyBound = false
    if (pointerMoveBound === true && doc !== undefined && doc !== null
      && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('mousemove', onMouseMove)
    }
    pointerMoveBound = false
    if (pointerBound === true && layerElement !== null
      && typeof layerElement.removeEventListener === 'function') {
      layerElement.removeEventListener('pointerdown', onPointerDown)
    }
    pointerBound = false
  }

  /**
   * The window lost the focus.
   */
  function onWindowBlur() {
    if (blurredSince === null) blurredSince = Date.now()
  }

  /**
   * The window got the focus back.
   */
  function onWindowFocus() {
    blurredSince = null
    activitySinceDismiss = true
  }

  /**
   * The page became visible or hidden.
   */
  function onVisibilityChange() {
    if (pageIsHidden()) {
      if (hiddenSince === null) hiddenSince = Date.now()
      return
    }
    hiddenSince = null
  }

  /**
   * The user pressed a key. Any key ends the layer.
   *
   * @param event - the keyboard event.
   */
  function onKeyDown(event) {
    if (visible === false) return
    if (event === undefined || event === null) return
    activitySinceDismiss = true
    dismiss()
  }

  /**
   * The user clicked the layer.
   *
   * @param event - the pointer event.
   */
  function onPointerDown(event) {
    if (visible === false) return
    activitySinceDismiss = true
    // ★ THE CLICK CANCELS THE PENDING STAND-DOWN, so the exit effect plays
    // instead of a plain fade.
    if (standDownTimer !== null) {
      globalThis.clearTimeout(standDownTimer)
      standDownTimer = null
    }
    dismiss()
  }

  /**
   * The pointer moved.
   *
   * ★ A MOVEMENT IS ACTIVITY, AND THE LAYER STANDS DOWN FOR IT — after a
   * short settle, so that a click (which is always preceded by a movement)
   * still gets the exit effect.
   *
   * @param event - the pointer event.
   */
  function onMouseMove(event) {
    if (visible === false) return
    activitySinceDismiss = true
    if (standDownTimer !== null) globalThis.clearTimeout(standDownTimer)
    standDownTimer = globalThis.setTimeout(function () {
      standDownTimer = null
      if (visible === false) return
      // ★ A STAND-DOWN IS NOT A DISMISSAL. The trigger simply stopped
      // holding, and the layer will come back when it holds again.
      standDown('pointer-moved')
    }, POINTER_SETTLE_MS)
  }

  /* --------------------------------------------------------- the rotation */

  /**
   * The family a material belongs to.
   *
   * ★ THE ROTATION POOL IS THE MATERIAL LIBRARY, GROUPED BY FAMILY.
   *
   * The slot names ONE material, so there is nothing to rotate to unless the
   * library holds more than one of the same kind. The family is the file name
   * without its extension and without a trailing number: `屏保3.mp4` and
   * `屏保4.mp4` are one family, `背景2.mp4` is another.
   *
   * @param name - the material's name.
   * @returns the family.
   */
  function familyOf(name) {
    if (typeof name !== 'string' || name === '') return ''
    var base = name.replace(/\.[^.]+$/, '')
    return base.replace(/-\d+$/, '')
  }

  /**
   * The materials the rotation may choose from.
   *
   * @returns the entries.
   */
  function rotationPool() {
    var entries = Array.isArray(lastCatalogEntries) ? lastCatalogEntries : []
    if (entries.length === 0) return []
    var current = findEntry(entries, lastMediaId)
    var family = familyOf(current !== null ? current.name : '')
    if (family === '') return entries
    var pool = []
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i]
      if (entry === undefined || entry === null) continue
      if (familyOf(entry.name) === family) pool.push(entry)
    }
    return pool.length > 0 ? pool : entries
  }

  /**
   * Arm the rotation timer.
   *
   * @param options - the screensaver's options.
   */
  function startRotation(options) {
    if (rotationTimer !== null) {
      globalThis.clearTimeout(rotationTimer)
      rotationTimer = null
    }
    var ms = options !== undefined && options !== null && typeof options === 'object'
      ? options.rotateMs
      : 0
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return
    rotationTimer = globalThis.setTimeout(function () {
      rotationTimer = null
      rotateNow()
    }, Math.round(ms))
  }

  /**
   * Swap the material, and dissolve between the two.
   *
   * ★ THE SWAP HAPPENS IN PLACE. It does not hide the layer and show it
   * again: that would play the exit effect and re-mount everything, which is
   * a dismissal nobody asked for.
   *
   * ★ AND A LOOPING MATERIAL NEVER ENDS, so there is no `ended` event to wait
   * for — the tick that finds the interval due IS the switch. That is the
   * earliest moment the user's setting allows.
   */
  function rotateNow() {
    if (visible === false) return
    var pool = rotationPool()
    if (pool.length < 2) return
    var candidates = []
    for (var i = 0; i < pool.length; i += 1) {
      if (pool[i] !== null && pool[i].id !== lastMediaId) candidates.push(pool[i])
    }
    if (candidates.length === 0) return
    var next = candidates[Math.floor(Math.random() * candidates.length)]
    // ★ THE SNAPSHOT IS TAKEN FIRST: the dissolve needs the old pixels, and
    // the new material only adds.
    var before = captureForDissolve()
    lastMediaId = next.id
    var result = applyEntry(next)
    if (result !== 'applied') return
    crossDissolve(before)
  }

  /**
   * A snapshot of what is on screen right now, for the dissolve.
   *
   * @returns the canvas, or null when a snapshot cannot be taken.
   */
  function captureForDissolve() {
    if (layerElement === null) return null
    var doc = globalThis.document
    if (doc === undefined || doc === null) return null
    var width = numberOrZero(layerElement.clientWidth)
    var height = numberOrZero(layerElement.clientHeight)
    if (width === 0 || height === 0) return null
    var small = doc.createElement('canvas')
    small.width = Math.max(1, Math.round(width / 4))
    small.height = Math.max(1, Math.round(height / 4))
    var surface = small.getContext('2d')
    if (surface === null || typeof surface === 'undefined') return null
    var source = mediaElement
    if (source === null || source === undefined) return null
    try {
      surface.drawImage(source, 0, 0, small.width, small.height)
    } catch (error) {
      // A canvas from another origin taints the snapshot.
      return null
    }
    return small
  }

  /**
   * Fade the previous picture out over the new one.
   *
   * ★ A CSS OPACITY RAMP IS NOT ENOUGH HERE: the old picture no longer exists
   * as an element, so it can only fade as a snapshot.
   *
   * @param before - the snapshot.
   */
  function crossDissolve(before) {
    if (before === null || before === undefined) return
    if (layerElement === null) return
    if (prefersReducedMotion() === true) return
    var doc = globalThis.document
    if (doc === undefined || doc === null) return
    var canvas = doc.createElement('canvas')
    canvas.className = 'dsham-saver-dissolve'
    canvas.width = before.width
    canvas.height = before.height
    try {
      canvas.style.position = 'absolute'
      canvas.style.inset = '0px'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.style.pointerEvents = 'none'
      canvas.style.zIndex = '2'
    } catch (error) {
      /* the canvas does not have a style object */
    }
    var surface = canvas.getContext('2d')
    if (surface === null || typeof surface === 'undefined') return
    try {
      surface.drawImage(before, 0, 0)
    } catch (error) {
      return
    }
    layerElement.appendChild(canvas)
    var FADE_MS = 420
    var startedAt = now()
    var step = function (timestamp) {
      var t = Math.min(1, (timestamp - startedAt) / FADE_MS)
      try { canvas.style.opacity = String(1 - t) } catch (error) { /* best effort */ }
      if (t >= 1) {
        dissolveFrame = null
        removeElement(canvas)
        return
      }
      if (typeof globalThis.requestAnimationFrame !== 'function') return
      dissolveFrame = globalThis.requestAnimationFrame(step)
    }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      dissolveFrame = globalThis.requestAnimationFrame(step)
    }
    // ★ A TIMER AS WELL AS THE RAMP: `requestAnimationFrame` does not run in a
    // hidden window, and a dissolve canvas that never got its last frame would
    // sit at full opacity forever.
    if (dissolveTimer !== null) globalThis.clearTimeout(dissolveTimer)
    dissolveTimer = globalThis.setTimeout(function () {
      dissolveTimer = null
      removeElement(canvas)
    }, FADE_MS + 400)
  }

  /* -------------------------------------------------------- the exit effect */

  /**
   * Which exit effect to play.
   *
   * ★ TWO QUESTIONS, TWO FIELDS. `options.screensaver.breakEffect` answers
   * "whether" the screensaver tears apart at all, and
   * `options.screensaver.breakStyle` answers "which" one it tears into. The
   * second question only means anything while the first one is on, and the
   * two are never merged into one control.
   *
   * ★ THE DEFAULT IS `particles`, AND AN UNKNOWN VALUE IS NOT A GUESS: a bad
   * write degrades to the original effect instead of to a wrong one.
   *
   * @param options - the screensaver's options.
   * @returns 'particles' | 'fall' | 'glitch'.
   */
  /** The break style that was played last, or null when none was. */
  var lastBreakStyle = null

  function breakStyleOf(options) {
    if (options === undefined || options === null || typeof options !== 'object') return 'particles'
    var value = options.breakStyle
    if (value === 'fall' || value === 'glitch') return value
    return 'particles'
  }

  /**
   * The artwork, at the resolution an effect needs.
   *
   * @param width - the viewport width in CSS pixels.
   * @param height - the viewport height in CSS pixels.
   * @returns the canvas, or null.
   */
  function snapshotFull(width, height) {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return null
    var full = doc.createElement('canvas')
    full.width = width
    full.height = height
    var context = full.getContext('2d')
    if (context === null || typeof context === 'undefined') return null
    var element = mediaElement
    if (element === null || element === undefined) return null
    if (typeof context.drawImage !== 'function') return null
    try {
      context.drawImage(element, 0, 0, width, height)
    } catch (error) {
      // A source that has not decoded yet throws.
      return null
    }
    return full
  }

  /**
   * The artwork at one sample per block, which IS the pixelation.
   *
   * @param width - the viewport width in CSS pixels.
   * @param height - the viewport height in CSS pixels.
   * @returns the canvas, or null.
   */
  function snapshotFrame(width, height) {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return null
    var BLOCK = 8
    var MAX_TILES = 20000
    var area = width * height
    var block = Math.max(BLOCK, Math.ceil(Math.sqrt(area / MAX_TILES)))
    var cols = Math.max(1, Math.ceil(width / block))
    var rows = Math.max(1, Math.ceil(height / block))
    var small = doc.createElement('canvas')
    small.width = cols
    small.height = rows
    var context = small.getContext('2d')
    if (context === null || typeof context === 'undefined') return null
    var element = mediaElement
    if (element === null || element === undefined) return null
    try {
      context.drawImage(element, 0, 0, cols, rows)
    } catch (error) {
      return null
    }
    return small
  }

  /**
   * Tear the picture apart.
   *
   * ★ THE LAYER COMES DOWN FIRST, BEFORE ANYTHING IS DRAWN, so the screen is
   * clear immediately whatever the effect costs.
   *
   * ★ ONE FULL-SCREEN CANVAS, ATTACHED TO THE DOCUMENT: the layer's opacity is
   * going to zero and a child would fade with it.
   *
   * ★ THE TWO SHATTER EFFECTS PAINT NO BACKGROUND OF THEIR OWN: the gaps are
   * the application underneath, and a user who asked to see it got a black
   * card dissolving instead of a screensaver breaking up. The glitch effect
   * is the third kind of thing — it draws the picture across the whole
   * canvas — and its own comment says so.
   */
  function playBreakEffect(style) {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return
    if (layerElement === null) {
      fadeOutAndRelease()
      return
    }
    var width = numberOrZero(layerElement.clientWidth)
    var height = numberOrZero(layerElement.clientHeight)
    // THE LAYER COMES DOWN FIRST.
    setLayerState('leaving')
    try {
      layerElement.style.opacity = '0'
      layerElement.style.pointerEvents = 'none'
    } catch (error) {
      /* the layer does not have a style object */
    }
    if (width === 0 || height === 0) {
      fadeOutAndRelease()
      return
    }
    var canvas = doc.createElement('canvas')
    canvas.className = 'dsham-saver-tear'
    canvas.width = width
    canvas.height = height
    try {
      canvas.style.position = 'fixed'
      canvas.style.inset = '0px'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.style.pointerEvents = 'none'
    } catch (error) {
      /* the canvas does not have a style object */
    }
    var host = doc.body
    if (host === undefined || host === null) host = doc.documentElement
    if (host === undefined || host === null) {
      fadeOutAndRelease()
      return
    }
    host.appendChild(canvas)
    // ★ TWO FAMILIES, TWO CAPTURES. The block effect takes one sample per
    // block — that IS its pixelation — while the fall and the glitch move the
    // picture around with window coordinates and need the frame at full size
    // or they misalign and blur.
    var art = style === 'particles' ? snapshotFrame(width, height) : snapshotFull(width, height)
    var finish = function () {
      removeElement(canvas)
      releaseScreensaver(false, false)
    }
    // ★ THE THREE EFFECTS ARE THREE DIFFERENT THINGS, and each one has its
    // own body below. An unrecognised style falls back to the first one
    // instead of quietly playing some other one.
    // ★ THE STATE REPORTS WHICH EFFECT WAS PLAYED. A diagnostic that cannot
    // see the value it is asked about is a broken instrument: without this,
    // "the setting was saved and the layer ignored it" and "the setting was
    // saved and the layer played the wrong one" look exactly the same.
    lastBreakStyle = style
    if (style === 'fall') breakFall(canvas, art, width, height, finish)
    else if (style === 'glitch') breakGlitch(canvas, art, width, height, finish)
    else breakParticles(canvas, art, width, height, finish)
  }

  /**
   * The blocks drift right and fade, in a left-to-right stagger.
   *
   * @param canvas - the canvas to draw on.
   * @param art - the artwork, one sample per block.
   * @param width - the width in CSS pixels.
   * @param height - the height in CSS pixels.
   * @param finish - called when the effect is over.
   */
  function breakParticles(canvas, art, width, height, finish) {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return
    var surface = canvas.getContext('2d')
    if (surface === null || typeof surface === 'undefined' || art === null) {
      finish()
      return
    }
    var BLOCK = 8
    var MAX_TILES = 20000
    var area = width * height
    var block = Math.max(BLOCK, Math.ceil(Math.sqrt(area / MAX_TILES)))
    var cols = Math.max(1, Math.ceil(width / block))
    var rows = Math.max(1, Math.ceil(height / block))
    var flights = new Float32Array(cols * rows * 4)
    for (var row = 0; row < rows; row += 1) {
      for (var col = 0; col < cols; col += 1) {
        var i = (row * cols + col) * 4
        flights[i] = (col / cols) * 0.9
        flights[i + 1] = (Math.random() * 2 - 1) * 40
        flights[i + 2] = (Math.random() * 2 - 1) * 24
        flights[i + 3] = 0.6 + Math.random() * 0.6
      }
    }
    var DURATION = 1400
    var startedAt = now()
    var handle = null
    var stopped = false
    var stop = function () {
      if (stopped) return
      stopped = true
      if (handle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(handle)
      }
      handle = null
      finish()
    }
    var draw = function (timestamp) {
      if (stopped) return
      var elapsed = (timestamp - startedAt) / 1000
      try {
        surface.clearRect(0, 0, width, height)
      } catch (error) {
        /* the canvas refused */
      }
      for (var row = 0; row < rows; row += 1) {
        for (var col = 0; col < cols; col += 1) {
          var i = (row * cols + col) * 4
          var delay = flights[i]
          var local = (elapsed - delay) / DURATION
          if (local < 0) continue
          if (local > 1) continue
          var eased = 1 - Math.pow(1 - local, 3)
          var dx = flights[i + 1] * eased
          var dy = flights[i + 2] * eased
          var alpha = Math.max(0, 1 - local) * flights[i + 3]
          try {
            surface.globalAlpha = alpha
            surface.drawImage(
              art,
              col, row, 1, 1,
              col * block + dx, row * block + dy, block, block,
            )
          } catch (error) {
            /* one bad tile must not stop the effect */
          }
        }
      }
      try { surface.globalAlpha = 1 } catch (error) { /* best effort */ }
      if (elapsed >= DURATION / 1000 + 1) {
        stop()
        return
      }
      if (typeof globalThis.requestAnimationFrame !== 'function') return
      handle = globalThis.requestAnimationFrame(draw)
    }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      handle = globalThis.requestAnimationFrame(draw)
    }
    globalThis.setTimeout(stop, DURATION + 600)
  }

  /**
   * 重力下坠 — the squares fall out of the bottom of the frame under gravity.
   *
   * ★ PORTED FROM `dsh-boot-animation`'s `breakFall()`.
   *
   * ★ THE CANVAS IS NOT FILLED. The gaps between the falling pieces are the
   * application underneath, and a fill would paint over them with an opaque
   * rectangle that fades out together with the pieces — a black card
   * dissolving instead of a screensaver breaking up. The pieces carry their
   * own pixels and nothing else.
   *
   * @param canvas - the canvas to draw on.
   * @param art - the artwork, at full resolution.
   * @param width - the width in CSS pixels.
   * @param height - the height in CSS pixels.
   * @param finish - called when the effect is over.
   */
  function breakFall(canvas, art, width, height, finish) {
    var surface = canvas.getContext('2d')
    if (surface === null || typeof surface === 'undefined' || art === null) {
      finish()
      return
    }
    var COLS = 28
    var bw = width / COLS
    var bh = bw
    var rowsN = Math.ceil(height / bh)
    var parts = []
    for (var r = 0; r < rowsN; r += 1) {
      for (var c = 0; c < COLS; c += 1) {
        parts.push({
          sx: c * bw,
          sy: r * bh,
          delay: Math.random() * 0.35,
          vx: (Math.random() - 0.5) * 90,
          vy: 380 + Math.random() * 260,
          spin: (Math.random() - 0.5) * 0.5,
        })
      }
    }
    var DURATION = 1350
    var startedAt = now()
    var handle = null
    var stopped = false
    var stop = function () {
      if (stopped) return
      stopped = true
      if (handle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(handle)
      }
      handle = null
      finish()
    }
    var draw = function (timestamp) {
      if (stopped) return
      var elapsed = (timestamp - startedAt) / 1000
      if (elapsed > DURATION / 1000) { stop(); return }
      try {
        surface.clearRect(0, 0, width, height)
      } catch (error) {
        /* the canvas refused */
      }
      for (var i = 0; i < parts.length; i += 1) {
        var p = parts[i]
        var t = Math.max(0, elapsed - p.delay)
        // Gravity: the distance grows with the square of the time, so the
        // pieces accelerate as they go.
        var dy = 0.5 * p.vy * t * t * 1.6
        var dx = p.vx * t
        if (p.sy + dy > height + bh) continue
        var alpha = Math.max(0, 1 - (t / (DURATION / 1000)) * 1.05)
        if (alpha <= 0) continue
        try {
          surface.globalAlpha = alpha
          surface.save()
          surface.translate(p.sx + bw / 2 + dx, p.sy + bh / 2 + dy)
          surface.rotate(p.spin * t * 0.55)
          surface.drawImage(art, p.sx, p.sy, bw + 0.5, bh + 0.5, -bw / 2, -bh / 2, bw + 0.5, bh + 0.5)
        } catch (error) {
          /* one bad piece must not stop the effect */
        }
        try {
          surface.restore()
        } catch (error) {
          /* the canvas refused */
        }
      }
      try { surface.globalAlpha = 1 } catch (error) { /* best effort */ }
      handle = globalThis.requestAnimationFrame(draw)
    }
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      stop()
      return
    }
    handle = globalThis.requestAnimationFrame(draw)
    // ★ A HARD STOP, so a browser that never delivers another frame cannot
    // leave the canvas up.
    globalThis.setTimeout(stop, 3600)
  }

  /**
   * A copy of the artwork that carries ONE colour channel and no colour of
   * its own.
   *
   * ★ THE MASK IS BUILT ON A PRIVATE CANVAS. This is the one place in the
   * exit effect that fills a surface, and it fills a buffer nobody ever
   * sees: the effect's own canvas carries the pieces and nothing else.
   *
   * @param art - the artwork.
   * @param width - the width in CSS pixels.
   * @param height - the height in CSS pixels.
   * @param color - the colour to keep.
   * @returns the canvas, or null.
   */
  function channelTint(art, width, height, color) {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return null
    var target = doc.createElement('canvas')
    target.width = width
    target.height = height
    try {
      var surface = target.getContext('2d')
      if (surface === null || typeof surface === 'undefined') return null
      surface.drawImage(art, 0, 0, width, height)
      // Multiply by a colour that is zero in the other channels, so the copy
      // keeps one channel and loses the colour of its own.
      surface.globalCompositeOperation = 'multiply'
      surface.fillStyle = color
      surface.fillRect(0, 0, width, height)
    } catch (error) {
      return null
    }
    return target
  }

  /**
   * Glitch·宽带位移 — wide horizontal bands displace, with a mosaic band and
   * a chroma split.
   *
   * ★ PORTED FROM `dsh-boot-animation`'s `breakGlitch()`.
   *
   * The loudest of the three: the bands are wide (20-90px) and the
   * displacement is large, so the picture reads as coming apart structurally
   * rather than as dissolving.
   *
   * @param canvas - the canvas to draw on.
   * @param art - the artwork, at full resolution.
   * @param width - the width in CSS pixels.
   * @param height - the height in CSS pixels.
   * @param finish - called when the effect is over.
   */
  function breakGlitch(canvas, art, width, height, finish) {
    var surface = canvas.getContext('2d')
    if (surface === null || typeof surface === 'undefined' || art === null) {
      finish()
      return
    }
    var doc = globalThis.document
    if (doc === undefined || doc === null) { finish(); return }

    // A downsampled copy for the mosaic band.
    var mos = doc.createElement('canvas')
    mos.width = Math.max(1, Math.round(width / 40))
    mos.height = Math.max(1, Math.round(height / 40))
    try {
      var mosSurface = mos.getContext('2d')
      if (mosSurface !== null && typeof mosSurface !== 'undefined') {
        mosSurface.drawImage(art, 0, 0, mos.width, mos.height)
      }
    } catch (error) {
      /* the mosaic is a garnish, not the effect */
    }

    // The chroma split is drawn with 'lighter' and a SINGLE-CHANNEL tint.
    // Both matter: a tinted copy carries black in the channels it does not
    // keep, so painting it back with source-over drains those channels and
    // dims the frame; 'lighter' only adds light.
    var redTint = channelTint(art, width, height, 'rgb(255,0,0)')
    var blueTint = channelTint(art, width, height, 'rgb(0,150,255)')

    var BANDS = 14
    var DURATION = 1350
    var startedAt = now()
    var bands = []
    var handle = null
    var stopped = false
    var stop = function () {
      if (stopped) return
      stopped = true
      if (handle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(handle)
      }
      handle = null
      finish()
    }
    var draw = function (timestamp) {
      if (stopped) return
      var elapsed = (timestamp - startedAt) / 1000
      var local = elapsed / (DURATION / 1000)
      if (local >= 1) { stop(); return }
      var intensity = 0.35 + Math.min(1, local / 0.35) * 0.65
      var fade = local > 0.72 ? 1 - (local - 0.72) / 0.28 : 1
      try {
        surface.clearRect(0, 0, width, height)
        surface.globalAlpha = fade
      } catch (error) {
        /* the canvas refused */
      }
      // The bands are re-cut every so often, so the picture keeps coming
      // apart instead of sliding once and staying there.
      if (bands.length === 0 || Math.random() < 0.16) {
        bands = []
        for (var k = 0; k < BANDS; k += 1) {
          bands.push({
            y: Math.random() * height,
            h: 20 + Math.random() * 70,
            offset: (Math.random() - 0.5) * 180,
            wob: Math.random() * Math.PI * 2,
          })
        }
      }
      try {
        surface.drawImage(art, 0, 0, width, height)
      } catch (error) {
        /* the canvas refused */
      }
      for (var i = 0; i < bands.length; i += 1) {
        var b = bands[i]
        var dx = b.offset * intensity + Math.sin(elapsed * 6 + b.wob) * 30 * intensity
        try {
          surface.save()
          surface.beginPath()
          surface.rect(0, b.y, width, b.h)
          surface.clip()
          surface.drawImage(art, 0, b.y, width, b.h, dx, b.y, width, b.h)
          surface.restore()
        } catch (error) {
          /* one bad band must not stop the effect */
        }
        // A bright seam at each band's edge: wide displacement needs an edge
        // or it reads as the picture sliding rather than as the picture being
        // cut.
        try {
          surface.globalAlpha = fade * 0.22 * intensity
          surface.fillStyle = 'rgba(210,235,255,1)'
          surface.fillRect(0, b.y, width, 1)
          surface.fillRect(0, b.y + b.h - 1, width, 1)
          surface.globalAlpha = fade
        } catch (error) {
          /* the canvas refused */
        }
      }

      // The mosaic band, drifting down.
      var my = ((local * 1.7) % 1) * height
      var mh = height * 0.16
      try {
        surface.save()
        surface.beginPath()
        surface.rect(0, my, width, mh)
        surface.clip()
        surface.imageSmoothingEnabled = false
        surface.drawImage(mos, 0, my * mos.height / height, mos.width, mh * mos.height / height, 0, my, width, mh)
        surface.imageSmoothingEnabled = true
        surface.restore()
      } catch (error) {
        /* the mosaic is a garnish */
      }

      // The chroma split, additive.
      var split = 3 + 10 * intensity
      try {
        surface.globalCompositeOperation = 'lighter'
        surface.globalAlpha = fade * 0.34
        if (redTint !== null) surface.drawImage(redTint, -split, 0, width, height)
        if (blueTint !== null) surface.drawImage(blueTint, split, 0, width, height)
        surface.globalCompositeOperation = 'source-over'
        surface.globalAlpha = fade
      } catch (error) {
        /* the canvas refused */
      }

      // Scanlines.
      try {
        surface.fillStyle = 'rgba(0,0,0,.24)'
        for (var y = 0; y < height; y += 3) surface.fillRect(0, y, width, 1)
        surface.globalAlpha = 1
      } catch (error) {
        /* the canvas refused */
      }
      handle = globalThis.requestAnimationFrame(draw)
    }
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      stop()
      return
    }
    handle = globalThis.requestAnimationFrame(draw)
    // ★ A HARD STOP, so a browser that never delivers another frame cannot
    // leave the canvas up.
    globalThis.setTimeout(stop, 3600)
  }

  /* ------------------------------------------------------- the pointer art */

  /**
   * Which pointer effect to play.
   *
   * ★ TWO QUESTIONS, TWO FIELDS. `options.screensaver.pointerEffect` answers
   * "whether" the decoration exists at all, and
   * `options.screensaver.pointerStyle` answers "which" one it is. The second
   * question only means anything while the first one is on.
   *
   * ★ THE DEFAULT IS `ripples`, AND AN UNKNOWN VALUE IS NOT A GUESS: a bad
   * write degrades to the first effect instead of to a wrong one.
   *
   * @param options - the screensaver's options.
   * @returns 'ripples' | 'attract'.
   */
  function pointerStyleOf(options) {
    if (options === undefined || options === null || typeof options !== 'object') return 'ripples'
    var value = options.pointerStyle
    if (value === 'attract') return 'attract'
    return 'ripples'
  }

  /**
   * Start the pointer decoration.
   *
   * ★ THE POINTER LISTENS ON THE DOCUMENT, NOT ON THE LAYER.
   *
   * The layer holds a full-bleed media element and the hint, so whether a
   * `mousemove` reaches the layer depends on where the event lands. The
   * document sees every move no matter which child it hit, so the decoration
   * is driven by coordinates instead of by hit-testing.
   *
   * ★ AND THE EFFECT IS CAUSED BY THE POINTER: a ring is drawn only while the
   * pointer is over the layer. A decoration that reacts to the pointer may
   * not play on a layer nobody is touching.
   *
   * @param options - the screensaver's options.
   */
  function startPointerArt(options) {
    stopPointerArt()
    if (options === undefined || options === null || typeof options !== 'object') return
    // ★ THE SWITCH ANSWERS "WHETHER" AND THE STYLE ANSWERS "WHICH". They are
    // two questions, and the second one only means anything while the first
    // one is on.
    if (options.pointerEffect !== true) return
    if (layerElement === null) return
    var doc = globalThis.document
    if (doc === undefined || doc === null) return
    var width = numberOrZero(layerElement.clientWidth)
    var height = numberOrZero(layerElement.clientHeight)
    if (width === 0 || height === 0) return
    var which = pointerStyleOf(options)
    var canvas = doc.createElement('canvas')
    canvas.className = 'dsham-saver-pointer'
    var dpr = Math.min(2, numberOrZero(globalThis.devicePixelRatio) || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    try {
      canvas.style.position = 'absolute'
      canvas.style.inset = '0px'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.style.pointerEvents = 'none'
      canvas.style.zIndex = '3'
    } catch (error) {
      /* the canvas does not have a style object */
    }
    layerElement.appendChild(canvas)
    var surface = canvas.getContext('2d')
    if (surface === null || typeof surface === 'undefined') {
      removeElement(canvas)
      return
    }
    var W = canvas.width
    var H = canvas.height
    var state = {
      canvas: canvas,
      surface: surface,
      which: which,
      rings: [],
      dust: null,
      inside: false,
      moves: 0,
      strokes: 0,
      running: false,
      handle: null,
      x: W / 2,
      y: H / 2,
      px: W / 2,
      py: H / 2,
      last: 0,
      dpr: dpr,
    }
    var onMove = function (event) {
      var rect = layerElement === null ? null : layerElement.getBoundingClientRect()
      if (rect === null || rect === undefined) return
      var right = typeof rect.right === 'number' ? rect.right : rect.left + rect.width
      var bottom = typeof rect.bottom === 'number' ? rect.bottom : rect.top + rect.height
      var inside = event.clientX >= rect.left && event.clientX <= right
        && event.clientY >= rect.top && event.clientY <= bottom
      state.moves += 1
      if (!inside) {
        state.inside = false
        return
      }
      state.x = (event.clientX - rect.left) * dpr
      state.y = (event.clientY - rect.top) * dpr
      state.inside = true
      if (state.running !== true) startLoop()
    }
    var onLeave = function () { state.inside = false }
    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('mousemove', onMove, { passive: true })
      doc.addEventListener('mouseleave', onLeave)
    }
    /**
     * 水波涟漪 — rings spreading out of the pointer, like a stone dropped in
     * water.
     *
     * ★ PORTED FROM `dsh-boot-animation`'s `tickRipples()`.
     *
     * ★ THE RINGS COME FROM THE POINTER, AND ONLY WHILE IT IS OVER THE LAYER.
     * A decoration that reacts to the pointer may not play on a layer nobody
     * is touching.
     *
     * @param dt - the frame's delta, in seconds.
     * @param timestamp - the frame's timestamp.
     * @returns true while there is something left to draw.
     */
    var tickRipples = function (dt, timestamp) {
      // ★ A RING EVERY 260 ms WHILE THE POINTER IS INSIDE, so the effect
      // does not look dead when the mouse is held still.
      if (state.inside === true) {
        var since = timestamp - (state.lastRing || 0)
        if (since >= 260) {
          state.lastRing = timestamp
          state.rings.push({ x: state.x, y: state.y, r: 0, life: 1 })
          if (state.rings.length > 40) state.rings.shift()
        }
      }
      var alive = []
      for (var i = 0; i < state.rings.length; i += 1) {
        var ring = state.rings[i]
        // ★ THE RADIUS IS INTEGRATED FROM `dt`, AND `dt` IS CLAMPED AT ZERO.
        // A negative delta would give the ring a negative radius, and
        // `CanvasRenderingContext2D.arc()` THROWS on a negative one.
        ring.r += 96 * dpr * dt
        ring.life -= dt / 1.6
        if (ring.life <= 0) continue
        alive.push(ring)
        var alpha = Math.min(1, ring.life * 1.6)
        try {
          surface.globalAlpha = alpha
          surface.beginPath()
          surface.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2)
          surface.strokeStyle = 'rgba(233,241,250,0.95)'
          surface.lineWidth = 5.5 * dpr
          surface.stroke()
          state.strokes += 1
        } catch (error) {
          /* one bad frame must not stop the loop */
        }
      }
      state.rings = alive
      try { surface.globalAlpha = 1 } catch (error) { /* best effort */ }
      return alive.length > 0 || state.inside === true
    }

    /**
     * The star field, built once per appearance.
     *
     * ★ PORTED FROM `dsh-boot-animation`'s `buildDust()`.
     *
     * ★ 520 MOTES, BECAUSE A HANDFUL OF FAINT DOTS DISAPPEARS INTO REAL
     * ARTWORK. Visibility here is density and size, not a flat alpha bump.
     *
     * @returns the motes.
     */
    var buildDust = function () {
      var COUNT = 520
      var dust = []
      for (var i = 0; i < COUNT; i += 1) {
        dust.push({
          x: Math.random(),
          y: Math.random(),
          vx: 0,
          vy: 0,
          size: 1.6 + Math.random() * 2.4,
          phase: Math.random() * Math.PI * 2,
        })
      }
      return dust
    }

    /**
     * 星屑吸附 — the motes are pulled toward the pointer while it is over the
     * layer.
     *
     * ★ PORTED FROM `dsh-boot-animation`'s `tickAttract()`.
     *
     * @param dt - the frame's delta, in seconds.
     * @returns true while there is something left to draw.
     */
    var tickAttract = function (dt) {
      if (state.dust === null) state.dust = buildDust()
      try {
        surface.clearRect(0, 0, W, H)
        surface.globalCompositeOperation = 'lighter'
      } catch (error) {
        /* the canvas refused */
      }
      var clock = now()
      for (var i = 0; i < state.dust.length; i += 1) {
        var d = state.dust[i]
        var px = d.x * W
        var py = d.y * H
        // ★ THE PULL ONLY EXISTS WHILE THE POINTER IS OVER THE LAYER. The
        // motes are caused by the pointer, not by the clock.
        if (state.inside === true) {
          var dx = state.x - px
          var dy = state.y - py
          var dist = Math.sqrt(dx * dx + dy * dy) || 1
          var pull = Math.max(0, 1 - dist / (420 * dpr)) * 900 * dpr
          d.vx += (dx / dist) * pull * dt
          d.vy += (dy / dist) * pull * dt
        }
        d.vx *= 0.94
        d.vy *= 0.94
        d.x += d.vx * dt / W
        d.y += d.vy * dt / H
        d.x += (Math.random() - 0.5) * 0.0004
        d.y += (Math.random() - 0.5) * 0.0004
        var twinkle = 0.6 + 0.4 * Math.sin(clock * 0.0016 + d.phase)
        var cx = d.x * W
        var cy = d.y * H
        var r = d.size * dpr
        try {
          // ★ THE HALO IS WHAT MAKES A MOTE READABLE over a bright picture:
          // three cheap squares beat a radial gradient per mote by two orders
          // of magnitude in cost.
          surface.fillStyle = 'rgba(150,205,255,' + (0.14 * twinkle) + ')'
          surface.fillRect(cx - r, cy - r, r * 3, r * 3)
          surface.fillStyle = 'rgba(190,230,255,' + (0.34 * twinkle) + ')'
          surface.fillRect(cx - r * 0.55, cy - r * 0.55, r * 2.1, r * 2.1)
          surface.fillStyle = 'rgba(235,248,255,' + (0.92 * twinkle) + ')'
          surface.fillRect(cx - r * 0.3, cy - r * 0.3, r * 1.6, r * 1.6)
          state.strokes += 3
        } catch (error) {
          /* one bad mote must not stop the loop */
        }
      }
      try {
        surface.globalCompositeOperation = 'source-over'
        surface.globalAlpha = 1
      } catch (error) {
        /* best effort */
      }
      return state.inside === true
    }

    var startLoop = function () {
      if (state.running === true) return
      state.running = true
      state.last = now()
      var tick = function (timestamp) {
        if (state.running !== true) return
        // ★ THE FIRST FRAME CAN HAVE A NEGATIVE `dt`, and integrating it kills
        // the loop on frame one.
        //
        // `startLoop()` seeds `state.last` from `performance.now()`, which is
        // a time-origin reading, while a `requestAnimationFrame` callback is
        // handed the FRAME-START timestamp — and that one can precede the
        // reading that scheduled it. Every effect integrates `dt` into a
        // size, and `arc()` THROWS on a negative radius, so the first frame
        // would kill the whole decoration.
        //
        // The clamp is at zero and BEFORE the `|| 0.016` fallback, so a
        // negative delta becomes one ordinary frame step instead of a
        // negative one.
        var elapsed = (timestamp - state.last) / 1000
        state.last = timestamp
        var dt = Math.min(0.05, Math.max(0, elapsed) || 0.016)
        try {
          surface.clearRect(0, 0, W, H)
        } catch (error) {
          /* the canvas refused */
        }
        var busy = state.which === 'attract' ? tickAttract(dt) : tickRipples(dt, timestamp)
        // ★ THE LOOP PARKS when there is nothing left to draw, and the next
        // pointer move restarts it.
        if (busy !== true) {
          state.running = false
          // ★ AND THE CANVAS IS CLEARED ON THE WAY OUT, so an effect that
          // stops does not leave its last frame on the screen.
          try { surface.clearRect(0, 0, W, H) } catch (error) { /* best effort */ }
          return
        }
        if (typeof globalThis.requestAnimationFrame !== 'function') return
        state.handle = globalThis.requestAnimationFrame(tick)
      }
      if (typeof globalThis.requestAnimationFrame !== 'function') {
        state.running = false
        return
      }
      state.handle = globalThis.requestAnimationFrame(tick)
    }
    pointerArt = {
      state: state,
      stop: function () {
        state.running = false
        if (state.handle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
          globalThis.cancelAnimationFrame(state.handle)
        }
        state.handle = null
      },
      detach: function () {
        if (typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('mousemove', onMove)
          doc.removeEventListener('mouseleave', onLeave)
        }
      },
      canvas: canvas,
    }
    // ★ THE LOOP STARTS ONLY WHEN THE POINTER SAYS SO. A decoration that
    // reacts to the pointer may not play on a layer nobody is touching, and
    // the pointer has to arrive before the effect exists at all — the layer
    // appears because the machine went idle, so the window is usually
    // unfocused and no pointer event is guaranteed.
    if (state.inside === true) startLoop()
  }

  /**
   * Tear the pointer decoration down. Safe to call when there is none.
   */
  function stopPointerArt() {
    if (pointerArt === null) return
    try {
      pointerArt.stop()
      if (typeof pointerArt.detach === 'function') pointerArt.detach()
      removeElement(pointerArt.canvas)
    } catch (error) {
      /* tearing down must never throw */
    }
    pointerArt = null
  }

  /* ------------------------------------------------------------ the machine */

  /**
   * Arm the surface's machinery: the host registration, the subscription, the
   * listeners, the observer and the timer.
   *
   * @returns true when the surface is armed.
   */
  function ensureRunning() {
    if (destroyed === true) return false
    var controller = arbitrationPoint()
    if (controller === null) {
      warnOnce('没有仲裁点，屏保表面不注册。')
      return false
    }
    // ★ THE HOST IS REGISTERED FIRST. Whoever asks for the screensaver — this
    // surface or the arbitration point itself — gets the material inside this
    // surface's stage.
    registerMediaHost()
    if (offChange === null) {
      try {
        offChange = controller.on('change', onChange)
      } catch (error) {
        offChange = null
      }
    }
    bindWindowListeners()
    ensureObserver()
    if (pollTimer === null && typeof globalThis.setInterval === 'function') {
      pollTimer = globalThis.setInterval(function () { evaluate() }, CHECK_MS)
    }
    return true
  }

  /**
   * The arbitration point published a change.
   *
   * @param payload - the change payload.
   */
  function onChange(payload) {
    if (payload === undefined || payload === null) return
    // ★ A RELEASE IN PROGRESS IGNORES THE CHANGE EVENTS. The arbitration
    // point publishes one while it releases, and re-applying the material in
    // the middle of a teardown would put it straight back.
    if (releasing === true) return
    var current = payload.state
    var stage = current !== undefined && current !== null ? current.slot : null
    var slots = current !== undefined && current !== null && current.slots !== undefined && current.slots !== null
      ? current.slots : {}
    var mine = slots[SLOT]
    var enabled = mine !== undefined && mine !== null && mine.enabled === true
    // ★ THE SCREENSAVER IS NOT ON THE STAGE ⇒ OUR LAYER GOES TOO — but only
    // when OUR material was the one on it. An empty stage at start-up is not a
    // lost stage.
    if (materialApplied === true && stage !== SLOT
      && (layerElement !== null || mediaElement !== null)) {
      releaseScreensaver(false, false)
      return
    }
    // ★ THE SLOT IS OFF ⇒ THE LAYER GOES WITH IT.
    if (materialApplied === true && enabled !== true
      && (layerElement !== null || mediaElement !== null)) {
      releaseScreensaver(false, false)
      return
    }
    var changed = Array.isArray(payload.changed) ? payload.changed : []
    if (changed.indexOf(SLOT) === -1 && payload.optionsChanged !== true) return
    evaluate()
  }

  /**
   * Evaluate the trigger, and act on the answer.
   *
   * @returns a promise for what happened.
   */
  function evaluate() {
    if (destroyed === true) return Promise.resolve(null)
    if (busy === true) return Promise.resolve(null)
    busy = true
    // ★ THE IDLE READING IS FETCHED, NOT AWAITED. The trigger decides with the
    // reading it has in hand; the new one arrives afterwards. That is what
    // makes a dismissal stick.
    pollIdle()
    return readSlots().then(function (payload) {
      var config = payload.config
      var slots = config.slots !== undefined && config.slots !== null ? config.slots : {}
      var group = slots[SLOT]
      var slot = group !== undefined && group !== null && typeof group === 'object' ? group : {}
      var options = config.options !== undefined && config.options !== null ? config.options : {}
      var own = options[SLOT]
      lastOptions = own !== undefined && own !== null && typeof own === 'object' ? own : {}
      // ★ THE SURFACE'S MACHINERY IS ARMED FIRST, even when nothing plays:
      // the user may turn the slot back on at any moment.
      if (ensureRunning() === false) return null
      // ★ THE OTHER PLUGIN IS ON THE STAGE ⇒ THIS SURFACE YIELDS.
      if (anotherWallpaperIsOnStage()) {
        yieldStage()
        return null
      }
      if (yielded === true) {
        yielded = false
      }
      var readings = collectReadings(config)
      var verdict = decide(readings)
      lastVerdict = verdict
      if (verdict.show === true) {
        if (visible === false) return showScreensaver(slot, lastOptions)
        return null
      }
      // ★ THE TRIGGER STOPPED HOLDING ⇒ THE LAYER STANDS DOWN. This is not a
      // dismissal: no latch is set, and the layer comes back when the trigger
      // holds again.
      if (visible === true) standDown('trigger-lost')
      return null
    }).catch(function (error) {
      warnOnce('读不到屏保配置：' + String(error !== undefined && error !== null && error.message
        ? error.message
        : error))
      return null
    }).then(function (result) {
      busy = false
      return result
    })
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
        visible: visible === true,
        dismissed: dismissedUntilActive === true,
        idleStatus: idleStatus,
        idleMs: lastIdleMs,
        blockedBy: lastVerdict !== null && lastVerdict !== undefined ? lastVerdict.blockedBy : null,
        mediaId: lastMediaId,
      })
    } catch (error) {
      /* the facts are best effort */
    }
  }

  /**
   * The surface's own state.
   *
   * @returns the facts.
   */
  function state() {
    return {
      visible: visible === true,
      layer: layerElement !== null,
      media: mediaElement !== null,
      yielded: yielded === true,
      dismissed: dismissedUntilActive === true,
      idleStatus: idleStatus,
      idleMs: lastIdleMs,
      thresholdMs: idleThresholdMs(lastOptions),
      blurredMs: Math.round(blurredFor()),
      hiddenMs: Math.round(hiddenFor()),
      visibility: pageIsHidden() ? 'hidden' : 'visible',
      turnRunning: chatTurnRunning(),
      bootOnStage: bootIsOnStage(),
      blockedBy: lastVerdict !== null && lastVerdict !== undefined ? lastVerdict.blockedBy : null,
      mediaId: lastMediaId,
      revision: lastRevision,
      lastResult: lastResult,
      breakStyle: lastBreakStyle,
      pointerStyle: pointerArt !== null && pointerArt.state !== null ? pointerArt.state.which : null,
      pointerArtMounted: pointerArt !== null,
      pointerStrokes: pointerArt !== null && pointerArt.state !== null ? pointerArt.state.strokes : 0,
      pointerMoves: pointerArt !== null && pointerArt.state !== null ? pointerArt.state.moves : 0,
    }
  }

  globalThis.__DSH_APPEARANCE_SCREENSAVER__ = {
    version: '0.1.0',
    available: arbitrationPoint() !== null,
    state: state,
    // ★ THE TRIGGER, AS A PURE FUNCTION. The offline suite drives it with
    // made-up readings, and the live path drives it with the real ones — the
    // SAME code, so a test that exercised a copy of the rule would be testing
    // the copy.
    decide: decide,
    readings: collectReadings,
    refresh: function () { return evaluate() },
    // ★ THE SAME PATH THE SURFACE ITSELF USES: the arbitration point does the
    // mounting, and the stage's host is registered for this slot ⇒ the
    // material lands inside the layer.
    apply: function (entry) { return applyEntry(entry) },
    release: function () { dismiss() },
    // ★ THE END OF THE SURFACE. The stage goes clean, the watcher goes with
    // it, and the host is forgotten — the one thing a release does NOT do.
    dispose: function () {
      destroyed = true
      releaseScreensaver(true, false)
      unregisterMediaHost()
    },
  }

  // ★ THE SURFACE STARTS ONLY WITH AN ARBITRATION POINT.
  //
  // No arbitration point ⇒ no surface: the surface warns once and touches
  // nothing. It never becomes an arbitration point of its own.
  if (arbitrationPoint() === null) {
    warnOnce('没有仲裁点，屏保表面不注册。')
  } else {
    ensureRunning()
    whenBodyReady().then(function () {
      ensureObserver()
      evaluate()
    })
  }
})()
