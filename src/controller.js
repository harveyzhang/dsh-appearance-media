// dsh-appearance-media — the single arbitration point. INJECTED SIDE.
//
// ★ THIS FILE IS SCRIPT TEXT, NOT A MODULE.
//
// The Host half reads this file and pushes it into the page as ONE inline
// `kind:'script'` row (see `index.js`). It has to run BEFORE the shell bundle
// — the boot screen has to come up before the application exists — and it has
// to be readable by a surface that installs itself even earlier. ⇒ NO
// `require`, NO `import`, NO `export`. Everything hangs off `globalThis`.
//
// WHAT IT IS: the one place that decides which of the three surfaces is on
// screen, what it is playing, how a hand-over happens and how a failure rolls
// back. The surfaces (background / boot / screensaver) come later; they ask
// THIS object to play and to stop, and they read their state from it.
//
// THE API:
//
//   state()            the current truth, as a fresh snapshot
//   apply(slot, entry) play `entry` on `slot`; SYNCHRONOUS
//   release(slot)      stop `slot`; idempotent; returns void
//   releaseAll()       stop everything; idempotent; returns void
//   on(event, fn)      subscribe; returns the unsubscribe function
//
// plus the extensions the later surfaces need, documented in docs/DETAIL.md:
//
//   refresh()          re-read the configuration now
//   report(slot, f)   a surface publishes its own facts into state().slots
//   start() / stop() / dispose()   the polling's life cycle
//   registerHost(slot, host) / unregisterHost(slot)
//                       ★ THE SURFACE'S OWN MOUNT POINT (see below)
//   pause(slot) / resume(slot)
//                       pause and continue the material that is on screen
//
// ★ THE HOST MAY HAVE TO BUILD ITS LAYER AGAIN.
//
// A surface owns a layer, and a release takes the layer away. So the host
// that the surface registers knows how to MAKE SURE ITS LAYER IS THERE
// (`ensure()`), and the arbitration point asks before it mounts.
//
//   ⇒ the layer is the surface's business, and the arbitration point never
//     builds a layer of its own (two places that build a layer are two
//     places that tell the truth);
//   ⇒ if the surface cannot give a host, the attempt FAILS: the answer is
//     `'failed-kept-previous'` and the old material stays exactly where it
//     is. Mounting on the body instead is the bug this rule was written for:
//     a media element on the body has no positioning and lands below the
//     viewport — invisible, and still downloading.
//
// ★ THE STAGE IS HANDED OVER, NOT THE SURFACES.
//
// The arbitration point remembers which slot another slot pushed off the
// stage. When the stage is free again, the slot that was pushed off comes
// back — the boot clip first, the screensaver second, the background last
// (the background is the environment: it never takes the stage away from a
// clip that is playing). ONE hand-over at a time, and the surfaces never
// have to know about each other.
//
// ★ THE HOST IS RESOLVED PER SLOT, NOT PER CALL.
//
// A surface owns a layer, and the media has to land INSIDE that layer —
// whoever asks for the material. The first version resolved the host from the
// global `__DSH_APPEARANCE_HOST__` and the surface swapped that global for
// the duration of its own call ⇒ a material switched by anyone else (the
// arbitration point's own `apply()`) fell back to the default host, landed
// straight on the body, lost the layer's positioning and disappeared below
// the viewport.
//
// ⇒ A surface REGISTERS its host for its slot, and UNREGISTERS it on
// release. `resolveHost(slot)` then answers, in this order:
//
//   1. the host registered for THAT slot;
//   2. the globally injected host;
//   3. the default host (the body).
//
// ★ THE HOST IS NEVER A GLOBAL THAT IS SWAPPED AND RESTORED. The scope of a
// swap is one call, and "one call" is exactly the scope that hid the bug.
//
// ★ PAUSE AND RESUME ARE NOT RELEASE.
//
// Releasing a background means re-streaming it when the user comes back: a
// hitch, and a decode from the start. Pausing keeps the stream and the
// position. ⇒ `pause(slot)` / `resume(slot)` are on the arbitration point,
// and the adapters answer them (a still picture has neither — the ABSENCES
// are the contract).
//
// ★ THE CONFIGURATION IS READ LIVE, NEVER BAKED.
//
// An injected row's TEXT is frozen when the desktop host starts (that is the
// host's own rule, not this file's). A configuration snapshot inside this
// text would therefore be a snapshot that never updates. ⇒ the configuration
// is fetched at runtime, every time, from the Host's own route.
//
// ★ TWO REVISIONS, TWO QUESTIONS, AND THEY MUST BE ASKED SEPARATELY.
//
// The Host answers with a WHOLE revision ("the configuration changed") and one
// revision PER SLOT ("this surface needs to be applied again"). Changing only
// the OPTIONS moves the whole revision and NONE of the slot revisions.
//
//   ⇒ the PER-SLOT revision decides whether a surface has to be applied again;
//   ⇒ the WHOLE revision decides whether the options have to be re-read.
//
// A controller that only compared the per-slot revisions would never notice a
// volume change: the volume would sit in the file, the assertions would stay
// green, and the user would hear nothing.
//
// ★ THE ENTRY IS THE CALLER'S TO RESOLVE.
//
// `apply(slot, entry)` takes a catalog entry — the very object the catalog
// route publishes, with its `mediaUrl` — and never fetches anything. The
// adapter uses `entry.mediaUrl` and builds no URL of its own.
//
// ★ THE ORDER OF `apply()` IS NOT INTERCHANGEABLE.
//
//   1. the new material is BUILT first; if that fails the old one stays;
//   2. only then is the old one released and the new one mounted.
//
// Releasing first and building afterwards means a failure leaves nothing to
// roll back to.
//
// ★ EVERY ASYNC CALLBACK CHECKS THE TOKEN.
//
// `apply()` stamps every attempt with an increasing token. A callback that
// belongs to an attempt that has been superseded does nothing at all: it must
// not touch the surface that replaced it.

/* eslint-disable */
;(function () {
  'use strict'

  /** The three slots this controller arbitrates. */
  var SLOT_NAMES = ['background', 'boot', 'screensaver']

  /** Where the slot configuration is read from. Always read live. */
  var SLOTS_URL = '/appearance-media/slots'

  /** How often the configuration is re-read, in milliseconds. */
  var POLL_MS = 800

  /**
   * Whether a surface LOOPS.
   *
   * The boot clip must not loop: its end IS the hand-over signal, and a
   * looping element never fires `ended`. The screensaver must loop: it covers
   * the screen for an unknown length of time, and a clip that stops leaves a
   * frozen frame on a layer that is supposed to be there. The background
   * loops for the screensaver's reason.
   */
  var LOOP_BY_SLOT = { background: true, boot: false, screensaver: true }

  /** The token of the newest attempt. Every async callback compares against it. */
  var applyToken = 0

  /** The material that is on screen right now, or null. */
  var current = null

  /** The choice that was on screen before `current`, for the rollback. */
  var previousChoice = null

  /** The subscribers. */
  var listeners = { change: [], error: [] }

  /** The polling timer, or null when it is not running. */
  var pollTimer = null

  /** The last error message that was published, so a poll that keeps failing stays quiet. */
  var lastErrorMessage = ''

  /** What each surface published about itself. */
  var slotExtras = {}

  /** The host interfaces the surfaces registered, per slot. */
  var slotHosts = {}

  /**
   * The order in which the slots take the stage back.
   *
   * ★ THE BOOT CLIP IS FIRST, THE SCREENSAVER IS SECOND, THE BACKGROUND IS
   * THE LAST. The background is the environment: it is nice to have, but it
   * never takes the stage away from a clip that is playing.
   */
  var SLOT_PRIORITY = ['boot', 'screensaver', 'background']

  /**
   * The slots that another slot pushed off the stage.
   *
   * ★ A SLOT THAT WAS PUSHED OFF COMES BACK; A SLOT THAT WAS RELEASED ON
   * PURPOSE STAYS RELEASED. The user turning the background off must not
   * have it come back on its own — and a clip that took the stage must
   * hand it back when it is done.
   */
  var displaced = {}

  /** The last entry that was applied on each slot. */
  var slotEntries = {}

  /** Whether a hand-over is already running. */
  var restoring = false

  /** The controller's own facts. */
  var state = {
    slot: null,
    mediaId: null,
    playing: false,
    paused: false,
    kind: null,
    error: null,
    revision: -1,
    slots: {
      background: { enabled: false, mediaId: null, revision: -1 },
      boot: { enabled: false, mediaId: null, revision: -1 },
      screensaver: { enabled: false, mediaId: null, revision: -1 },
    },
    options: {
      background: {},
      boot: {},
      screensaver: {},
    },
  }

  /**
   * Whether a value is a plain object.
   * @param value - the value.
   * @returns true for an object that is not an array and not null.
   */
  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  /**
   * Clamp a number into 0..1.
   * @param value - the value.
   * @returns the clamped number.
   */
  function clamp01(value) {
    if (typeof value !== 'number' || !isFinite(value)) return 0
    if (value < 0) return 0
    if (value > 1) return 1
    return value
  }

  /**
   * Whether two option groups carry the same thing.
   * @param left - one group.
   * @param right - the other group.
   * @returns true when they are equal.
   */
  function sameOptions(left, right) {
    var a = isPlainObject(left) ? left : {}
    var b = isPlainObject(right) ? right : {}
    var keysA = Object.keys(a)
    var keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (var i = 0; i < keysA.length; i += 1) {
      var key = keysA[i]
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (a[key] !== b[key]) return false
    }
    return true
  }

  /**
   * The host interface: where elements come from, and how they reach the page.
   *
   * ★ THE SLOT COMES FIRST. A surface registers the host it wants its
   * material mounted into, and that registration is per slot: whoever asks
   * for the material, the element lands in the surface's layer.
   *
   * ★ THE SURFACE IS ASKED WHETHER ITS LAYER IS THERE — but only when the
   * caller is about to MOUNT something. A release must not build a layer
   * just to take an element away from it.
   *
   * @param slot - the slot the element belongs to.
   * @param ask - true when the surface has to make sure its layer exists.
   * @returns the host, or null when there is none and `ask` is true.
   */
  function resolveHost(slot, ask) {
    var registered = typeof slot === 'string' ? slotHosts[slot] : undefined
    if (registered !== undefined && registered !== null
      && typeof registered.createElement === 'function') {
      // ★ THE LAYER IS THE SURFACE'S, AND THE SURFACE SAYS WHEN IT IS BACK.
      // A release takes the layer away, so the next material has to ask for
      // it again — and the surface is the only one that may build it.
      if (ask === true && typeof registered.ensure === 'function') {
        var ensured = null
        // ★ A SURFACE THAT CANNOT ANSWER IS A FAILURE, NOT A CRASH. The
        // attempt fails loudly and the old material stays.
        try {
          ensured = registered.ensure()
        } catch (error) {
          ensured = null
        }
        if (ensured === undefined || ensured === null) return null
      }
      return registered
    }
    var injected = globalThis.__DSH_APPEARANCE_HOST__
    if (injected !== undefined && injected !== null
      && typeof injected.createElement === 'function') {
      return injected
    }
    // ★ NEVER THE BODY. A media element that is mounted straight on the
    // body has no positioning: it falls into the document flow and lands
    // below the viewport — invisible, and still downloading. If there is no
    // host, the caller has to be told.
    return ask === true ? null : defaultHost()
  }

  /**
   * Register the host a surface wants its material mounted into.
   *
   * ★ THE SURFACE OWNS THE REGISTRATION. It registers when it comes up, and
   * the registration stays as long as the surface lives — a release takes
   * the LAYER away, not the surface, and the layer is built again when the
   * next material asks for it.
   *
   * ★ THE HOST MAY CARRY TWO MORE METHODS:
   *
   *   `ensure()`     make sure the layer is there; return false/null when
   *                  it cannot be built. The arbitration point asks for it
   *                  before it mounts, and a "no" is a failure — never a
   *                  silent mount on the body.
   *   `resolve(id)`  turn a media id into a catalog entry. The arbitration
   *                  point remembers ids, not URLs: the entry — and with it
   *                  the `mediaUrl` — is the surface's business.
   *
   * @param slot - the slot.
   * @param host - the host interface (`createElement` is required).
   * @returns true when the host was registered.
   */
  function registerHost(slot, host) {
    if (typeof slot !== 'string' || SLOT_NAMES.indexOf(slot) === -1) return false
    if (host === undefined || host === null) return false
    if (typeof host.createElement !== 'function') return false
    slotHosts[slot] = host
    return true
  }

  /**
   * Forget the host a surface registered.
   *
   * @param slot - the slot.
   * @returns true when there was a registration to forget.
   */
  function unregisterHost(slot) {
    if (typeof slot !== 'string') return false
    if (!Object.prototype.hasOwnProperty.call(slotHosts, slot)) return false
    delete slotHosts[slot]
    return true
  }

  /**
   * The host that talks to the browser's document.
   *
   * It only appends a child to the body and removes a child again. It writes
   * no attribute on the body, no class, no dataset, no style.
   *
   * @returns the default host.
   */
  function defaultHost() {
    return {
      createElement: function (tag) {
        var doc = globalThis.document
        if (doc === undefined || doc === null || typeof doc.createElement !== 'function') {
          throw new Error('没有可用的 DOM。')
        }
        return doc.createElement(tag)
      },
      mount: function (element) {
        var doc = globalThis.document
        if (doc === undefined || doc === null) return
        var body = doc.body
        if (body === undefined || body === null) return
        if (typeof body.appendChild === 'function') body.appendChild(element)
      },
      unmount: function (element) {
        if (element === undefined || element === null) return
        if (typeof element.remove === 'function') {
          element.remove()
          return
        }
        var parent = element.parentNode
        if (parent !== undefined && parent !== null && typeof parent.removeChild === 'function') {
          parent.removeChild(element)
        }
      },
    }
  }

  /**
   * The current truth, as a fresh snapshot.
   *
   * A snapshot, not the live object: a caller cannot change the controller's
   * state by writing into what `state()` returned.
   *
   * @returns the snapshot.
   */
  function snapshot() {
    var slots = {}
    for (var i = 0; i < SLOT_NAMES.length; i += 1) {
      var name = SLOT_NAMES[i]
      var source = state.slots[name]
      var extra = isPlainObject(slotExtras[name]) ? slotExtras[name] : {}
      var slot = {
        enabled: source.enabled === true,
        mediaId: source.mediaId,
        revision: source.revision,
      }
      var keys = Object.keys(extra)
      for (var k = 0; k < keys.length; k += 1) slot[keys[k]] = extra[keys[k]]
      // ★ THE ARBITRATION POINT'S OWN TRUTH WINS. A surface publishes what
      // only it knows (its hidden flag, its video count); whether a slot is
      // on the stage is the one thing that lives here.
      //
      // ★ `playing` MEANS "IT IS RUNNING". A slot that is on the stage but
      // paused is `paused`, not `playing` — and the hand-over uses this to
      // decide who is still on the stage.
      slot.playing = state.slot === name && state.playing === true && state.paused !== true
      slot.paused = state.slot === name && state.paused === true
      slots[name] = slot
    }
    return {
      slot: state.slot,
      mediaId: state.mediaId,
      playing: state.playing === true,
      paused: state.paused === true,
      kind: state.kind,
      error: state.error,
      revision: state.revision,
      slots: slots,
    }
  }

  /**
   * Publish a change.
   *
   * The payload carries the state, the slots whose own revision moved, and
   * whether the options moved.
   *
   * @param detail - `{ changed, optionsChanged }`.
   */
  function emitChange(detail) {
    var payload = {
      state: snapshot(),
      changed: detail !== undefined && Array.isArray(detail.changed) ? detail.changed : [],
      optionsChanged: detail !== undefined && detail.optionsChanged === true,
    }
    var list = listeners.change.slice()
    for (var i = 0; i < list.length; i += 1) {
      try {
        list[i](payload)
      } catch (error) {
        /* a broken subscriber must not stop the others */
      }
    }
  }

  /**
   * Publish an error.
   *
   * The same message twice in a row is published once: a poll that keeps
   * failing would otherwise flood the subscribers every 800 ms.
   *
   * @param error - the error, or a message.
   * @param quiet - true to record it without publishing it.
   */
  function emitError(error, quiet) {
    var message = error !== undefined && error !== null && error.message !== undefined
      ? String(error.message)
      : String(error)
    state.error = { message: message, slot: state.slot }
    if (quiet === true) return
    if (message === lastErrorMessage) return
    lastErrorMessage = message
    var payload = { error: state.error }
    var list = listeners.error.slice()
    for (var i = 0; i < list.length; i += 1) {
      try {
        list[i](payload)
      } catch (failure) {
        /* a broken subscriber must not stop the others */
      }
    }
  }

  /**
   * The renderer options for one slot.
   *
   * ★ `loop` IS NOT READ FROM THE CONFIGURATION. It is what the surface IS:
   * the boot clip hands over at its end, the screensaver never ends.
   *
   * @param slot - the slot name.
   * @returns `{ loop, muted, volume }` — always a complete object.
   */
  function rendererOptions(slot) {
    var group = isPlainObject(state.options[slot]) ? state.options[slot] : {}
    var options = {
      loop: LOOP_BY_SLOT[slot] === true,
      muted: true,
      volume: 1,
    }
    options.muted = group.muted !== false
    if (slot === 'screensaver') options.volume = clamp01(group.volume)
    return options
  }

  /**
   * Push the current audio parameters onto the material that is on screen.
   *
   * ★ THIS IS WHAT MAKES AN OPTIONS CHANGE TAKE EFFECT. The options do not
   * move any slot's revision, so nothing else would ever tell the running
   * material that the volume changed.
   *
   * ★ THE ABSENCES ARE THE CONTRACT: an image has neither `setVolume` nor
   * `mute`, and asking for a method that is not there is not an error — it is
   * how a still picture says "I have no sound".
   */
  function applyAudioParameters() {
    if (current === null) return
    var renderer = current.renderer
    if (renderer === undefined || renderer === null) return
    var options = rendererOptions(current.slot)
    if (typeof renderer.setVolume === 'function') {
      try { renderer.setVolume(options.volume) } catch (error) { /* the level is best effort */ }
    }
    if (typeof renderer.mute === 'function') {
      try { renderer.mute(options.muted) } catch (error) { /* the mute is best effort */ }
    }
  }

  /**
   * Release the material that is on screen.
   *
   * The order is fixed: the renderer tears itself down (pause, clear the
   * source, unbind, disconnect, clear timers) and only then does the element
   * leave the page. The element goes last on purpose: an element that left
   * the page while its source was still attached would keep being downloaded
   * and decoded by the browser.
   */
  function releaseCurrent() {
    if (current === null) return
    var renderer = current.renderer
    // ★ THE SLOT IS READ BEFORE `current` IS CLEARED: the unmount has to ask
    // the host that belongs to THIS slot.
    var slot = current.slot
    current = null
    state.slot = null
    state.mediaId = null
    state.kind = null
    state.playing = false
    state.paused = false
    if (renderer === undefined || renderer === null) return
    if (typeof renderer.dispose === 'function') {
      try { renderer.dispose() } catch (error) { /* the renderer owns its own cleanup */ }
    }
    var element = typeof renderer.el === 'function' ? renderer.el() : null
    if (element === undefined || element === null) return
    try { resolveHost(slot).unmount(element) } catch (error) { /* the page is not ours to fix */ }
  }

  /**
   * The material failed after it was mounted.
   *
   * @param token - the token of the attempt this callback belongs to.
   * @param code - whatever the renderer reported.
   */
  function onRendererError(token, code) {
    // ★ THE TOKEN CHECK. An attempt that has been superseded must not touch
    // the material that replaced it.
    if (token !== applyToken) return
    emitError({ message: '媒体出错了。', code: code })
    var fallback = previousChoice
    if (fallback !== null && fallback !== undefined && current !== null
      && fallback.mediaId !== current.mediaId) {
      // Try to revive the choice that was on screen before this one.
      if (apply(fallback.slot, fallback.entry) === 'applied') return
    }
    releaseCurrent()
    emitChange({ changed: [] })
  }

  /**
   * The material refused to start.
   *
   * A refused `play()` is usually the browser's autoplay policy. The element
   * may still show a frame, so the material stays and the error is reported;
   * the surface decides what to do with it.
   *
   * @param token - the token of the attempt this callback belongs to.
   * @param error - the rejection.
   */
  function onStartFailure(token, error) {
    if (token !== applyToken) return
    emitError({
      message: '播放被拒绝了：' + String(error !== undefined && error !== null && error.message
        ? error.message
        : error),
    })
  }

  /**
   * Play one entry on one slot.
   *
   * @param slot - 'background' | 'boot' | 'screensaver'.
   * @param entry - a catalog entry, with `kind` and `mediaUrl`.
   * @returns 'applied' | 'skipped' | 'failed-kept-previous' | 'failed-released'.
   */
  function apply(slot, entry) {
    if (typeof slot !== 'string' || SLOT_NAMES.indexOf(slot) === -1) return 'skipped'
    if (!isPlainObject(entry)) return 'skipped'
    // ★ THE KIND IS CLOSED. An entry whose kind is missing or unknown is not
    // a failure: there is nothing to play, so nothing is played and nothing
    // is touched.
    var kind = entry.kind
    if (kind !== 'video' && kind !== 'image') return 'skipped'
    if (typeof entry.mediaUrl !== 'string' || entry.mediaUrl === '') return 'skipped'
    var mediaId = typeof entry.id === 'string' ? entry.id : null

    // ★ IDEMPOTENCE: the same slot, the same material and the same slot
    // revision means the same thing is already on screen.
    if (current !== null && current.slot === slot && current.mediaId === mediaId
      && current.revision === state.slots[slot].revision) {
      return 'skipped'
    }

    var factory = globalThis.__DSH_APPEARANCE_RENDERERS__
    if (factory === undefined || factory === null || typeof factory.create !== 'function') {
      // There is no adapter factory at all: the new material cannot be built,
      // so the old one stays exactly where it is.
      return 'failed-kept-previous'
    }
    var renderer = null
    try {
      renderer = factory.create(entry, rendererOptions(slot))
    } catch (error) {
      emitError({ message: '适配器建不起来：' + String(error !== undefined && error !== null && error.message
        ? error.message
        : error) })
      return 'failed-kept-previous'
    }
    if (renderer === undefined || renderer === null || typeof renderer.el !== 'function') {
      // The factory could not build this material: the old one stays.
      emitError({ message: '这个素材没有可用的适配器。', slot: slot })
      return 'failed-kept-previous'
    }

    // ★ THE HOST IS ASKED FOR BEFORE THE OLD MATERIAL GOES.
    //
    // The surface owns the layer, and a release takes the layer away — so
    // the surface is asked whether it can put one back. If it cannot, this
    // attempt FAILS and the old material stays exactly where it is.
    //
    // ★ MOUNTING ON THE BODY INSTEAD IS THE BUG THIS RULE WAS WRITTEN FOR:
    // a media element on the body has no positioning, falls into the
    // document flow and lands below the viewport.
    var host = resolveHost(slot, true)
    if (host === null) {
      if (typeof renderer.dispose === 'function') {
        try { renderer.dispose() } catch (error) { /* the renderer owns its own cleanup */ }
      }
      emitError({ message: '这个槽位拿不到宿主。', slot: slot })
      return 'failed-kept-previous'
    }

    var token = ++applyToken

    // ★ THE NEW MATERIAL IS READY. NOW THE OLD ONE GOES.
    if (current !== null) {
      previousChoice = { slot: current.slot, entry: current.entry, mediaId: current.mediaId }
      // ★ THE OLD SLOT WAS PUSHED OFF THE STAGE. It is remembered, so that
      // it can take the stage back when the slot that took it is released.
      if (current.slot !== slot) displaced[current.slot] = true
    }
    releaseCurrent()
    // ★ THIS SLOT IS THE ONE ON THE STAGE NOW.
    delete displaced[slot]
    slotEntries[slot] = entry

    var element = renderer.el()
    // ★ THE SLOT DECIDES WHERE THE ELEMENT GOES. The surface registered its
    // own host for this slot, so the material lands inside the surface's
    // layer — no matter who asked for it.
    try { host.mount(element) } catch (error) { /* the host refused the element */ }

    current = {
      slot: slot,
      mediaId: mediaId,
      kind: kind,
      revision: state.slots[slot].revision,
      renderer: renderer,
      entry: entry,
      token: token,
    }
    state.slot = slot
    state.mediaId = mediaId
    state.kind = kind
    state.playing = true
    state.paused = false
    state.error = null

    // The error path is bound BEFORE the start, so a failure cannot slip past.
    if (typeof renderer.onError === 'function') {
      renderer.onError(function (code) { onRendererError(token, code) })
    }
    // ★ THE SAME ORDER FOR THE SOUND. A clip that had to be muted to start is
    //   not a failure — the picture is on screen — but the user asked for sound
    //   and did not get it, so the fact is published next to the material's own
    //   facts and the surface can say so.
    if (typeof renderer.onDowngrade === 'function') {
      renderer.onDowngrade(function (reason) {
        if (token !== applyToken) return
        report(slot, { mutedDowngraded: true, mutedDowngradeReason: String(reason) })
      })
    }
    var started
    try {
      started = renderer.start()
    } catch (error) {
      releaseCurrent()
      emitError({ message: '媒体起不来：' + String(error !== undefined && error !== null && error.message
        ? error.message
        : error) })
      return 'failed-released'
    }
    if (started !== undefined && started !== null && typeof started.then === 'function') {
      started.then(function () {}, function (error) { onStartFailure(token, error) })
    }
    emitChange({ changed: [slot] })
    return 'applied'
  }

  /**
   * Pause the material that is on screen.
   *
   * ★ PAUSING IS NOT RELEASING. A released background has to be streamed and
   * decoded again when the user comes back — a hitch, and a lost position.
   * A paused one keeps both.
   *
   * ★ THE ABSENCES ARE THE CONTRACT: a still picture has neither `pause` nor
   * `resume`, and asking for a method that is not there is not an error — it
   * is how a still picture says "I am not playing anyway".
   *
   * @param slot - the slot.
   * @returns true when the material was paused.
   */
  function pause(slot) {
    if (current === null) return false
    if (current.slot !== slot) return false
    var renderer = current.renderer
    if (renderer === undefined || renderer === null) return false
    if (typeof renderer.pause !== 'function') return false
    try {
      renderer.pause()
    } catch (error) {
      return false
    }
    state.paused = true
    emitChange({ changed: [slot] })
    return true
  }

  /**
   * Continue the material that is on screen.
   *
   * @param slot - the slot.
   * @returns true when the material was continued.
   */
  function resume(slot) {
    if (current === null) return false
    if (current.slot !== slot) return false
    var renderer = current.renderer
    if (renderer === undefined || renderer === null) return false
    if (typeof renderer.resume !== 'function') return false
    var result
    try {
      result = renderer.resume()
    } catch (error) {
      return false
    }
    state.paused = false
    if (result !== undefined && result !== null && typeof result.then === 'function') {
      result.then(function () {}, function (error) { onStartFailure(applyToken, error) })
    }
    emitChange({ changed: [slot] })
    return true
  }

  /**
   * Whether a slot is the one on the stage, and running.
   *
   * @param name - the slot name.
   * @returns true when the slot is playing.
   */
  function isSlotPlaying(name) {
    return state.slot === name && state.playing === true && state.paused !== true
  }

  /**
   * Turn a media id into the entry that carries the media URL.
   *
   * ★ THE ENTRY IS THE SURFACE'S BUSINESS. The arbitration point remembers
   * an id, never a URL — so it asks the surface that owns the slot. A
   * surface that cannot answer falls back to the entry it was given last.
   *
   * @param slot - the slot name.
   * @param mediaId - the media id.
   * @returns a promise for the entry, or null.
   */
  function resolveEntryFor(slot, mediaId) {
    var provider = slotHosts[slot]
    if (provider !== undefined && provider !== null && typeof provider.resolve === 'function') {
      try {
        var resolved = provider.resolve(mediaId)
        if (resolved !== undefined && resolved !== null && typeof resolved.then === 'function') {
          return resolved.then(function (entry) { return entry }, function () { return null })
        }
        return Promise.resolve(resolved)
      } catch (error) {
        return Promise.resolve(null)
      }
    }
    var cached = slotEntries[slot]
    return Promise.resolve(cached === undefined ? null : cached)
  }

  /**
   * Bring back the slot that another slot pushed off the stage.
   *
   * ★ ONE AT A TIME, HIGHEST PRIORITY FIRST. The boot clip goes before the
   * screensaver, the screensaver before the background: the background is
   * the environment and never takes the stage away from a clip.
   *
   * ★ THE SLOT HAS TO BE ENABLED AND MUST NOT BE PLAYING. A slot the user
   * turned off stays off, and a slot that is on the stage stays there.
   *
   * ★ A SLOT THAT WAS RELEASED ON PURPOSE DOES NOT COME BACK. The user
   * turned it off, and turning it off has to mean it — so only the slots
   * that another slot pushed off are candidates (and a slot that never had
   * anything on the stage, which simply has not come up yet).
   *
   * ★ THE SURFACES NEVER HAVE TO KNOW ABOUT EACH OTHER. The arbitration
   * point is the only one that remembers who was pushed off.
   */
  function restoreDisplaced() {
    if (restoring === true) return
    var candidates = []
    for (var i = 0; i < SLOT_PRIORITY.length; i += 1) {
      var name = SLOT_PRIORITY[i]
      // ★ ONLY A SLOT THAT WAS PUSHED OFF THE STAGE IS A CANDIDATE.
      //
      // "Pushed off" is what `displaced` means: the slot was on the stage and
      // another slot took over. Two things are deliberately NOT candidates:
      //
      //   - a slot that was released ON PURPOSE. Nobody pushed it off; it
      //     must not come back on its own.
      //   - a slot that has NEVER been on the stage. Enabling the boot
      //     screen halfway through a session must not drag the boot overlay
      //     onto the screen in the middle of a conversation — and the
      //     surfaces that need to come back poll for a free stage anyway.
      //
      // The rule the hand-over follows is therefore exactly: enabled AND
      // pushed off AND not playing right now.
      if (displaced[name] !== true) continue
      if (state.slots[name].enabled !== true) continue
      if (state.slot === name) continue
      if (isSlotPlaying(name)) continue
      candidates.push(name)
    }
    // ★ ONE AT A TIME. The hand-over is a single step: the slots come back
    // one after the other, highest priority first.
    if (candidates.length === 0) return
    var slot = candidates[0]
    // ★ THE OTHER SLOTS KEEP THEIR MARK AND COME BACK LATER.
    delete displaced[slot]
    restoring = true
    resolveEntryFor(slot, state.slots[slot].mediaId).then(function (entry) {
      restoring = false
      if (entry === undefined || entry === null) return
      apply(slot, entry)
    }, function () {
      restoring = false
    })
  }

  /**
   * Give the stage to somebody else for a while.
   *
   * ★ THIS IS NOT `release()`. A release says "this slot will not play
   * again" — the user turned it off, and turning it off has to mean it. A
   * displacement says "somebody else needs the stage for now": the material
   * goes away, the slot stays enabled, and the slot is marked as PUSHED OFF
   * so that the hand-over can bring it back.
   *
   * The difference matters for the yielding surfaces: a wallpaper plugin
   * taking the stage is a temporary thing, and the surface has to come back
   * on its own when the other plugin leaves.
   *
   * ★ NO HAND-OVER HAPPENS HERE. The displaced slot is not restored right
   * away: the stage may still belong to the other plugin. The arbitration
   * point decides when and in which order the displaced slots come back —
   * that decision belongs to the arbitration point alone.
   *
   * @param slot - the slot name.
   */
  function displace(slot) {
    if (typeof slot !== 'string' || SLOT_NAMES.indexOf(slot) === -1) return
    // ★ THE SLOT IS MARKED AS PUSHED OFF WHETHER OR NOT IT WAS ON THE
    // STAGE. A slot that was never on the stage and is now pushed aside is
    // exactly the slot that must not be dragged onto the stage later.
    displaced[slot] = true
    if (current === null) return
    if (current.slot !== slot) return
    releaseCurrent()
    emitChange({ changed: [slot] })
  }

  /**
   * Let the arbitration point decide who comes back.
   *
   * ★ ONE ROAD FOR EVERY COMEBACK. A surface that notices the stage is free
   * again calls THIS, and the arbitration point applies its own rule: the
   * slots that were pushed off, enabled, highest priority first, one at a
   * time. A surface must never decide that by itself — that would be a
   * second rulebook, and two rulebooks disagree.
   *
   * ★ THE CONFIGURATION IS READ FIRST. The slots are the truth, and the
   * truth may have moved while this slot was pushed off.
   */
  function restore() {
    return refresh().then(function () { restoreDisplaced() })
  }

  /**
   * Stop one slot.
   *
   * Idempotent, and it never touches a slot that is not the one on screen.
   *
   * ★ THE STAGE IS FREE AGAIN ⇒ THE SLOT THAT WAS PUSHED OFF COMES BACK.
   * A slot that was released on purpose is not restored: the user turned it
   * off, and turning it off has to mean it.
   *
   * @param slot - the slot name.
   */
  function release(slot) {
    if (current === null) return
    if (current.slot !== slot) return
    releaseCurrent()
    emitChange({ changed: [slot] })
    restoreDisplaced()
  }

  /**
   * Stop everything.
   *
   * ★ "STOP EVERYTHING" MEANS STOP EVERYTHING: nothing is handed back
   * afterwards. The hand-over belongs to `release(slot)` — that is the one
   * that says "the stage is free again".
   */
  function releaseAll() {
    if (current === null) return
    releaseCurrent()
    emitChange({ changed: [] })
  }

  /**
   * Subscribe.
   *
   * @param event - 'change' | 'error'.
   * @param fn - the callback.
   * @returns the unsubscribe function.
   */
  function on(event, fn) {
    if (typeof fn !== 'function') return function () {}
    var list = listeners[event]
    if (list === undefined) return function () {}
    list.push(fn)
    var done = false
    return function () {
      if (done) return
      done = true
      var index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    }
  }

  /**
   * A surface publishes its own facts into `state().slots[slot]`.
   *
   * The background surface's own `hidden` and `videoCount` live here, so that
   * there is ONE place that answers "what is on screen".
   *
   * @param slot - the slot name.
   * @param fields - the fields to publish.
   */
  function report(slot, fields) {
    if (typeof slot !== 'string' || SLOT_NAMES.indexOf(slot) === -1) return
    if (!isPlainObject(fields)) return
    var extra = isPlainObject(slotExtras[slot]) ? slotExtras[slot] : {}
    var changed = false
    var keys = Object.keys(fields)
    for (var i = 0; i < keys.length; i += 1) {
      if (extra[keys[i]] !== fields[keys[i]]) changed = true
      extra[keys[i]] = fields[keys[i]]
    }
    slotExtras[slot] = extra
    if (changed) emitChange({ changed: [slot] })
  }

  /**
   * Fold one configuration answer into the controller's facts.
   *
   * @param payload - the answer of the slot route.
   * @returns what moved.
   */
  function applyPayload(payload) {
    var config = isPlainObject(payload) && isPlainObject(payload.config) ? payload.config : {}
    var nextRevision = typeof config.revision === 'number' ? config.revision : state.revision
    var changed = []
    var i

    for (i = 0; i < SLOT_NAMES.length; i += 1) {
      var name = SLOT_NAMES[i]
      var source = isPlainObject(config.slots) && isPlainObject(config.slots[name])
        ? config.slots[name]
        : {}
      var revision = typeof source.revision === 'number' ? source.revision : state.slots[name].revision
      if (revision !== state.slots[name].revision) changed.push(name)
      state.slots[name].enabled = source.enabled === true
      state.slots[name].mediaId = typeof source.mediaId === 'string' ? source.mediaId : null
      state.slots[name].revision = revision
    }

    // ★ THE OPTIONS. They are compared by VALUE, because the whole revision
    // also moves when a slot's material changes — and a material change is
    // not an options change.
    var optionsChanged = false
    var groups = isPlainObject(config.options) ? config.options : {}
    for (i = 0; i < SLOT_NAMES.length; i += 1) {
      var group = SLOT_NAMES[i]
      if (!sameOptions(state.options[group], groups[group])) optionsChanged = true
      state.options[group] = isPlainObject(groups[group]) ? groups[group] : {}
    }

    var configChanged = nextRevision !== state.revision
    state.revision = nextRevision

    // ★ THE OPTIONS ARE PUSHED ONTO THE MATERIAL THAT IS ON SCREEN. Without
    // this, a volume change would sit in the file and never reach the
    // screen, and every assertion would stay green.
    if (optionsChanged) applyAudioParameters()

    if (configChanged || optionsChanged || changed.length > 0) {
      emitChange({ changed: changed, optionsChanged: optionsChanged })
    }
    return { changed: changed, optionsChanged: optionsChanged, configChanged: configChanged }
  }

  /**
   * Read the slot configuration, now.
   * @returns a promise for the answer.
   */
  function readSlots() {
    var fetcher = globalThis.fetch
    if (typeof fetcher !== 'function') {
      return Promise.reject(new Error('这个环境没有 fetch。'))
    }
    return Promise.resolve(fetcher(SLOTS_URL, { cache: 'no-store' })).then(function (response) {
      if (response === undefined || response === null || response.ok !== true) {
        throw new Error('宿主没有应答槽位配置。')
      }
      return response.json()
    }).then(function (payload) {
      if (!isPlainObject(payload) || payload.ok !== true || !isPlainObject(payload.config)) {
        throw new Error('槽位配置的形状不对。')
      }
      return payload
    })
  }

  /**
   * Re-read the configuration and fold it in.
   * @returns a promise for what moved, or null when the read failed.
   */
  function refresh() {
    return readSlots().then(function (payload) {
      return applyPayload(payload)
    }).catch(function (error) {
      emitError({
        message: '读不到槽位配置：' + String(error !== undefined && error !== null && error.message
          ? error.message
          : error),
      }, true)
      return null
    })
  }

  /**
   * Start reading the configuration.
   */
  function start() {
    if (pollTimer !== null) return
    if (typeof globalThis.setInterval === 'function') {
      pollTimer = globalThis.setInterval(function () { refresh() }, POLL_MS)
    }
    refresh()
  }

  /**
   * Stop reading the configuration.
   */
  function stop() {
    if (pollTimer === null) return
    if (typeof globalThis.clearInterval === 'function') globalThis.clearInterval(pollTimer)
    pollTimer = null
  }

  /**
   * Stop reading, and let go of everything that is on screen.
   */
  function dispose() {
    stop()
    releaseCurrent()
  }

  globalThis.__DSH_APPEARANCE_CONTROLLER__ = {
    state: snapshot,
    apply: apply,
    release: release,
    releaseAll: releaseAll,
    on: on,
    refresh: refresh,
    report: report,
    start: start,
    stop: stop,
    dispose: dispose,
    registerHost: registerHost,
    unregisterHost: unregisterHost,
    displace: displace,
    restore: restore,
    pause: pause,
    resume: resume,
  }

  // The controller reads the configuration from the very beginning: a surface
  // that installs itself later still finds the current revision waiting.
  start()
})()
