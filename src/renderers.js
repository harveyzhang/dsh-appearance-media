// dsh-appearance-media — the media adapters. INJECTED SIDE.
//
// ★ THIS FILE IS SCRIPT TEXT, NOT A MODULE.
//
// The Host half reads this file and pushes it into the page as ONE inline
// `kind:'script'` row (see `index.js`). It is plain script text on purpose:
// it has to run BEFORE the shell bundle, and the shell bundle is not a module
// boundary this file can cross. ⇒ NO `require`, NO `import`, NO `export`.
// Everything it touches hangs off `globalThis`.
//
// WHAT IT IS: the place where the difference between a video and an image
// lives. The controller asks a renderer a fixed set of questions and never
// inspects the material itself:
//
//   el()            the DOM node to put on the page                  (required)
//   start()         begin playing / show it                          (required)
//   dispose()       release everything this renderer created          (required)
//   onShown(fn)     report that a picture exists
//   onError(fn)     report that it failed
//   hasAudio()      whether a sound affordance is worth offering
//   kind            'video' | 'image'
//   raw             the underlying element
//
// ★ THE ABSENCES ARE THE CONTRACT.
//
// A still image has no `duration()` and no `onEnded()`, so the caller routes it
// through its existing "unknown length" path — which is exactly right for
// something that cannot end. A renderer that grew a fake `duration()` would
// change the hand-over timing for EVERY kind, and every offline assertion
// would still be green. The video-only methods are:
//
//   duration()  onEnded(fn)  setVolume(v)  mute(b)  currentTime()
//   isEnded()   isPaused()   getVolume()   isMuted()  onStall(fn)
//   mediaError()  pause()  resume()
//
// ★ `pause()` AND `resume()` ARE VIDEO-ONLY AS WELL.
//
// A still picture is not playing, so it cannot be paused or continued — and
// saying so by ABSENCE is how the caller learns it without asking the element
// a question it cannot answer.
//
// ★ `loop` IS DECIDED BY THE CALLER, NOT BY THIS FILE.
//
// The boot clip must NOT loop — its end IS the hand-off signal, and a looping
// element never fires `ended`, so a looping boot clip holds the screen
// forever. The screensaver MUST loop — its job is to cover the screen for an
// unknown length of time, and a non-looping clip stops dead when it runs out.
// Both were real bugs in the plugin this contract was copied from, and both
// were found only in a browser.
//
// ★ THE URL COMES FROM `entry.mediaUrl` AND FROM NOWHERE ELSE.
//
// The catalog publishes the URL; the adapter uses it. An adapter that builds
// its own URL has invented a contract nobody wrote down, and it breaks the
// moment the route moves.
//
// ★ THE DOM COMES THROUGH A HOST INTERFACE.
//
// `globalThis.__DSH_APPEARANCE_HOST__` may supply `createElement`, `mount` and
// `unmount`. Without one, the built-in host talks to `document`. The logic in
// this file never touches `document` itself, so it can be exercised offline
// against a fake DOM.

/* eslint-disable */
;(function () {
  'use strict'

  /**
   * The kinds this factory can build. The set is closed: anything else is a
   * material this build cannot play, and the factory says so by answering
   * `undefined` rather than by guessing.
   */
  var SUPPORTED_KINDS = ['video', 'image']

  /**
   * The host interface: where elements come from, and how they reach the page.
   *
   * The default host is the browser's own document. A test (or a surface that
   * owns its own layer) can replace it.
   *
   * @returns an object with `createElement`, `mount` and `unmount`.
   */
  function resolveHost() {
    var injected = globalThis.__DSH_APPEARANCE_HOST__
    if (injected !== undefined && injected !== null
      && typeof injected.createElement === 'function') {
      return injected
    }
    return defaultHost()
  }

  /**
   * The host that talks to the browser's document.
   *
   * It only ever APPENDS a child to the body and REMOVES a child again. It
   * writes no attribute on the body, no class, no dataset, no style: that
   * marker belongs to another plugin, and writing it would break their
   * cleanup logic.
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
        // The body may not exist yet: an injected row lives in <head>, and the
        // boot screen has to come up before the shell exists.
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
   * Wrap a callback so it runs at most once.
   * @param fn - the callback.
   * @returns the wrapped callback.
   */
  function once(fn) {
    var fired = false
    return function () {
      if (fired) return
      fired = true
      if (typeof fn === 'function') fn()
    }
  }

  /* ---------------------------------------------------------------- video */

  /**
   * A video clip.
   *
   * The only kind with a real timeline, and therefore the only kind that can
   * report its end, its length, or its stall.
   *
   * @param entry - a catalog entry; its `mediaUrl` is the source.
   * @param options - `{ loop, muted, volume }`. NEVER undefined in practice:
   *   the controller always passes a complete object.
   * @returns the renderer.
   */
  function videoRenderer(entry, options) {
    var host = resolveHost()
    var video = host.createElement('video')
    video.className = 'dsham-media'
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.preload = 'auto'

    // ★ THE ORDER IS FIXED, AND `src` COMES LAST.
    //
    // `muted` and `loop` have to be their final values before the source is
    // assigned, because the element's first play already honours them. A
    // media element is BUILT muted when an unattended layer may start on its
    // own, so a sound setting has to UNMUTE it rather than merely stop muting
    // it.
    video.muted = options.muted === true
    video.loop = options.loop === true
    if (typeof options.volume === 'number' && isFinite(options.volume)) {
      video.volume = options.volume < 0 ? 0 : (options.volume > 1 ? 1 : options.volume)
    }
    // ★ THE SOURCE IS THE LAST THING THAT IS ASSIGNED.
    video.src = entry.mediaUrl

    var shownCbs = []
    var endedCbs = []
    var errorCbs = []
    var stallCbs = []
    var downgradeCbs = []

    /**
     * Whether an error is the browser refusing to start playback on its own.
     *
     * ★ THE BROWSER HAS A POLICY AND IT IS NOT NEGOTIABLE. A media element
     * that is NOT muted may only start without a user gesture when the page
     * already carries one. On a page that does not (the application was just
     * launched and nobody has touched anything yet), the browser refuses with
     * NotAllowedError — and the element stays paused at frame zero.
     *
     * ★ THAT IS NOT A GLITCH THE USER CAN SEE. The element is loaded, the
     * decoder is ready, `readyState` is 4 — and nothing moves. The screen
     * shows the first frame of a clip that never plays, and when the first
     * frames of the clips are alike that looks exactly like "the same clip
     * every time".
     *
     * @param error - the rejection.
     * @returns {boolean} whether this is the autoplay policy.
     */
    function isAutoplayRefusal(error) {
      if (error === undefined || error === null) return false
      var name = typeof error.name === 'string' ? error.name : ''
      if (name === 'NotAllowedError') return true
      var code = typeof error.code === 'number' ? error.code : -1
      return code === 0 || code === 1
    }

    /**
     * "A frame exists" is not the same fact as "play() resolved": a resolved
     * promise only means the element left the paused state.
     */
    var fireShown = once(function () {
      for (var i = 0; i < shownCbs.length; i += 1) shownCbs[i]()
    })

    function onLoadedData() {
      if (video.readyState >= 2) fireShown()
    }
    function onCanPlay() {
      if (video.readyState >= 2) fireShown()
    }
    function onTimeUpdate() {
      if (video.currentTime > 0) fireShown()
    }
    function onEnded() {
      for (var i = 0; i < endedCbs.length; i += 1) endedCbs[i]()
    }
    function onElementError() {
      var code = video.error ? video.error.code : 0
      for (var i = 0; i < errorCbs.length; i += 1) errorCbs[i](code)
    }
    function onStall() {
      for (var i = 0; i < stallCbs.length; i += 1) stallCbs[i]()
    }

    video.addEventListener('loadeddata', onLoadedData)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('ended', onEnded)
    video.addEventListener('error', onElementError)
    video.addEventListener('stalled', onStall)
    video.addEventListener('waiting', onStall)
    if (video.readyState >= 2) fireShown()

    return {
      kind: 'video',
      el: function () { return video },
      /**
       * Start the clip.
       *
       * ★ THE BROWSER MAY REFUSE, AND THE CLIP MUST STILL PLAY.
       *
       * A sound clip cannot start by itself on a page without a user gesture.
       * The rejection is not a failure of the material: the same clip, muted,
       * is allowed to start. So the refusal is answered with a muted retry
       * instead of an error — the screen gets its picture either way, and the
       * caller is told that the sound was given up (`onDowngrade`) so it can
       * say so.
       *
       * @returns a promise for the start, or undefined.
       */
      start: function () {
        var promise = video.play()
        if (promise === undefined || promise === null || typeof promise.catch !== 'function') {
          return promise
        }
        return promise.catch(function (error) {
          if (video.muted === false && isAutoplayRefusal(error)) {
            // ★ THE MUTE HAS TO HAPPEN BEFORE THE RETRY, not after: the
            //   element reads its muted state when the play is requested.
            video.muted = true
            for (var i = 0; i < downgradeCbs.length; i += 1) {
              try { downgradeCbs[i]('autoplay-refused') } catch (failure) { /* a listener owns its own failure */ }
            }
            return video.play()
          }
          throw error
        })
      },
      /**
       * The teardown, in the fixed order: pause, clear the source, unbind the
       * listeners, drop the observers, clear the timers.
       *
       * ★ CLEARING THE SOURCE IS NOT OPTIONAL. The browser keeps downloading
       * and decoding a media element whose source is still attached, and a
       * half-decoded body is worse than no body at all.
       */
      dispose: function () {
        try { video.pause() } catch (error) { /* never started */ }
        video.removeAttribute('src')
        try { video.load() } catch (error) { /* detaching the source is best effort */ }
        video.removeEventListener('loadeddata', onLoadedData)
        video.removeEventListener('canplay', onCanPlay)
        video.removeEventListener('timeupdate', onTimeUpdate)
        video.removeEventListener('ended', onEnded)
        video.removeEventListener('error', onElementError)
        video.removeEventListener('stalled', onStall)
        video.removeEventListener('waiting', onStall)
        shownCbs.length = 0
        endedCbs.length = 0
        errorCbs.length = 0
        stallCbs.length = 0
      },
      onShown: function (fn) { shownCbs.push(fn) },
      onEnded: function (fn) { endedCbs.push(fn) },
      onError: function (fn) { errorCbs.push(fn) },
      onStall: function (fn) { stallCbs.push(fn) },
      /**
       * Report that the material had to give up its sound to start.
       *
       * @param fn - the listener; it receives the reason.
       */
      onDowngrade: function (fn) { downgradeCbs.push(fn) },
      duration: function () { return video.duration },
      currentTime: function () { return video.currentTime },
      isEnded: function () { return video.ended === true },
      isPaused: function () { return video.paused === true },
      /**
       * Pause without letting go of the stream.
       *
       * ★ THIS IS NOT A RELEASE. The source stays attached and the position
       * stays where it was, so continuing is instant.
       */
      pause: function () {
        try { video.pause() } catch (error) { /* never started */ }
      },
      /**
       * Continue where the element left off.
       * @returns the play promise, so the caller can see a refusal.
       */
      resume: function () {
        return video.play()
      },
      hasAudio: function () { return true },
      setVolume: function (value) {
        if (typeof value !== 'number' || !isFinite(value)) return
        video.volume = value < 0 ? 0 : (value > 1 ? 1 : value)
      },
      getVolume: function () { return video.volume },
      mute: function (value) { video.muted = value === true },
      isMuted: function () { return video.muted === true },
      mediaError: function () { return video.error ? video.error.code : 0 },
      raw: video,
    }
  }

  /* ---------------------------------------------------------------- image */

  /**
   * A still image.
   *
   * No timeline at all: it is "shown" as soon as it has decoded, it never
   * ends, and it makes no sound. Every one of those is expressed by the
   * ABSENCE of a method.
   *
   * @param entry - a catalog entry; its `mediaUrl` is the source.
   * @returns the renderer.
   */
  function imageRenderer(entry) {
    var host = resolveHost()
    var img = host.createElement('img')
    img.className = 'dsham-media'
    // The image is decorative: the layer around it carries the meaning.
    img.alt = ''
    img.decoding = 'async'

    var shownCbs = []
    var errorCbs = []
    var fireShown = once(function () {
      for (var i = 0; i < shownCbs.length; i += 1) shownCbs[i]()
    })

    function onLoad() {
      fireShown()
    }
    function onError() {
      for (var i = 0; i < errorCbs.length; i += 1) errorCbs[i](0)
    }

    img.addEventListener('load', onLoad)
    img.addEventListener('error', onError)
    img.src = entry.mediaUrl
    // A cached image is already complete when the handler is attached.
    if (img.complete === true && img.naturalWidth > 0) fireShown()

    return {
      kind: 'image',
      el: function () { return img },
      // Nothing to start: the load already began.
      start: function () { return undefined },
      dispose: function () {
        img.removeAttribute('src')
        img.removeEventListener('load', onLoad)
        img.removeEventListener('error', onError)
        shownCbs.length = 0
        errorCbs.length = 0
      },
      onShown: function (fn) { shownCbs.push(fn) },
      onError: function (fn) { errorCbs.push(fn) },
      hasAudio: function () { return false },
      raw: img,
    }
  }

  /* --------------------------------------------------------------- factory */

  /**
   * Build a renderer for one catalog entry.
   *
   * @param entry - a catalog entry (`kind`, `mediaUrl`, …).
   * @param options - `{ loop, muted, volume }`. The caller MUST pass it; the
   *   factory defaults it so a missing argument cannot throw, but a missing
   *   argument also means `loop` is false, which is the wrong answer for a
   *   surface that has to loop.
   * @returns the renderer, or undefined when the kind is unknown.
   */
  function create(entry, options) {
    if (entry === undefined || entry === null || typeof entry !== 'object') return undefined
    var kind = entry.kind
    if (SUPPORTED_KINDS.indexOf(kind) === -1) return undefined
    var opts = options === undefined || options === null ? {} : options
    if (kind === 'video') return videoRenderer(entry, opts)
    return imageRenderer(entry)
  }

  globalThis.__DSH_APPEARANCE_RENDERERS__ = { create: create }
})()
