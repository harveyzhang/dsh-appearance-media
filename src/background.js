// dsh-appearance-media — the chat background surface. INJECTED SIDE.
//
// ★ THIS FILE IS SCRIPT TEXT, NOT A MODULE.
//
// The Host half reads this file and pushes it into the page as ONE inline
// `kind:'script'` row (see `index.js`). It runs in <head>, before the shell
// bundle and before the client half exists. ⇒ NO `require`, NO `import`, NO
// `export`, NO script-tag closer, NO HTML comment opener.
//
// WHAT IT IS: the layer that sits BEHIND the chat window. It owns four things
// and nothing else:
//
//   1. the transparent-surface CSS (the host's own body is opaque, and the
//      chat frame carries the opaque colour);
//   2. the layer element the media is mounted into;
//   3. the release of everything when the page is hidden;
//   4. the decision to yield the stage to another wallpaper plugin.
//
// ★ IT DOES NOT PLAY THE MEDIA ITSELF.
//
// The media is played through the arbitration point: `apply(SLOT, entry)` to
// start, `release(SLOT)` to stop. The arbitration point owns the element, the
// state and the race handling; this file owns the layer, the CSS and the
// lifetime. Two copies of "what is playing" would drift.
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
// ★ WHY THIS FILE CANNOT USE THE CLIENT HALF'S `exports.arbitrationPoint()`.
//
// The client half is a CommonJS module inside the host's module loader, and it
// is only materialized when the settings UI needs it — long after this row has
// run, and possibly never. An injected row cannot `require` it, and the
// background has to work whether or not the user ever opens the settings
// panel. So both halves read the SAME published arbitration point; the surface
// never becomes one of its own.
//
// ★ THE CONFIGURATION IS READ LIVE, NEVER BAKED.
//
// An injected row's TEXT is frozen when the desktop host starts. A
// configuration snapshot inside this text would therefore be a snapshot that
// never updates ⇒ the settings would only take effect on a host restart. So
// the slot configuration and the catalog are fetched at runtime, every time
// the surface re-evaluates.
//
// ★ THE TRANSPARENT SURFACE CSS IS OURS.
//
// The host paints an opaque colour on the body, and the chat frame paints an
// opaque colour of its own. Both have to become transparent for the media to
// show through. The frame's class name is HASHED by the shell's build, so it
// can only be matched by substring: `[class*="_frame"]`. Writing the full
// hashed name down would break on the next build, and a substring match on
// `frame` alone would hit classes this build uses for something else.
//
// ★ `z-index` IS `0`, NOT `-1`.
//
// The body's own background is opaque, and a layer painted below it is not
// visible at all. `z-index: 0` puts the layer above the body's background and
// below everything the shell stacks above it.
//
// ★ THE YIELDING CHECK READS, IT NEVER WRITES.
//
// Another wallpaper plugin marks the body with an attribute of its own (the
// name is in the read below). When that marker is present and not empty, that
// plugin is on the stage and this surface withdraws: the layer goes away and
// the playback stops.
//
// ★ THE MARKER IS ONLY READ. This file writes NO attribute on the body — not
// the marker, not a class, not an inline style. The body is only ever
// appended to. The marker belongs to the other plugin, and a plugin that
// writes it breaks the other plugin's cleanup.
//
// ★ THE RELEASE ORDER IS A CONTRACT, AND IT IS NOT INTERCHANGEABLE.
//
//   pause → clear the source → unbind the listeners → disconnect the observer
//        → clear the timer → remove the elements
//
// "Clear the source" is not optional and it comes FIRST, right after the
// pause: the browser keeps downloading and decoding a media element whose
// source is still attached, and a half-decoded body is worse than no body.
//
// The media's own teardown (pause, clear the source, unbind its listeners)
// belongs to the adapter, and the arbitration point calls it. This file adds
// its own steps around it and removes the elements LAST.
//
// ★ THE MEDIA IS MOUNTED INSIDE THE LAYER, WHOSEVER ASKS FOR IT.
//
// The arbitration point asks the host interface where an element should go,
// and it asks PER SLOT. This surface therefore REGISTERS its own host for
// its slot — and keeps it registered, because a release takes the LAYER
// away, not the surface.
//
// ★ THE HOST IS THE SURFACE'S, AND THE HOST CAN ASK FOR ITS LAYER BACK.
//
// The registered host carries an `ensure()`: "make sure your layer is
// there". The arbitration point asks for it before it mounts anything.
// ⇒ the layer is built in exactly one place (here);
// ⇒ if the layer cannot be built, the attempt FAILS and the old material
//   stays. The arbitration point never falls back to the body — a media
//   element on the body has no positioning and lands below the viewport.
//
// ★ THE FIRST VERSION SWAPPED THE GLOBAL HOST INSTEAD, and it was wrong: the
// swap only covered this file's own call, so a material switched by the
// arbitration point itself (that is the user's "pick another clip" path)
// landed on the body instead of in the layer, lost the layer's positioning
// and disappeared below the viewport.
//
// ★ ONE VIDEO AT A TIME. A switched material does not pause the old one and
// leave it on the page: the old element is REMOVED. Pausing is what hiding
// does (`pauseWhenHidden`), not what switching does — a paused element with
// its source still attached keeps downloading.
//
// ★ THE LAYER AND THE TRANSPARENT CSS GO TOGETHER.
//
// Releasing the material has to take the layer and the injected style with
// it: a transparent shell with nothing behind it is a broken interface, not
// an off switch.
//
// ★ THE YIELDING IS A QUIET RELEASE — AND THE EARS STAY.
//
// Letting another wallpaper plugin have the stage is "somebody else is
// taking over" ⇒ the stage has to be handed over CLEAN: the media, the
// layer, the injected style, all of it. Otherwise the other plugin's own
// cleanup fights with what we left behind.
//
// ★ BUT THE WATCHER STAYS. The observer, the poll and the subscription are
// the ears that hear the other plugin leave the stage again. A full release
// would take them with it — and then nobody would know that the stage is
// free again, and the background would never come back.
//
// ★ AND THE SLOT IS NOT TOUCHED. The user did not turn the background off:
// the slot stays enabled, with the same material. The yielding is not a
// release on purpose — it is a push off the stage, and a pushed-off slot
// comes back BY ITSELF: nobody presses a button and nobody reloads the
// page.
//
// ★ THE BACKGROUND DOES NOT TAKE THE STAGE AWAY FROM A CLIP.
//
// The priority (boot > screensaver > background) is the arbitration point's
// rule. This surface waits while somebody else is on the stage; the
// arbitration point brings the background back when the stage is free again.
//
// ★ HIDDEN MEANS PAUSED, NOT RELEASED.
//
// Releasing a background means streaming and decoding it again when the user
// comes back — a hitch, and a lost position. Pausing keeps both. The option
// `options.background.pauseWhenHidden` decides (it is true by default).

/* eslint-disable */
;(function () {
  'use strict'

  /** The slot this surface owns. */
  var SLOT = 'background'

  /** Where the slot configuration is read from. Always read live. */
  var SLOTS_URL = '/appearance-media/slots'

  /** Where the catalog is read from. Always read live. */
  var CATALOG_URL = '/appearance-media/catalog.json'

  /** How often the surface re-evaluates itself, in milliseconds. */
  var POLL_MS = 1000

  /** The layer element: the surface's own element, mounted on the body. */
  var layerElement = null

  /** The mask element: the veil between the media and the chat. */
  var maskElement = null

  /** The style element: the transparent-surface CSS and the layer's CSS. */
  var styleElement = null

  /** The media element the arbitration point mounted into the layer. */
  var mediaElement = null

  /** The observer that watches the body for the other plugin's marker. */
  var observer = null

  /** The poll timer, or null when it is not running. */
  var pollTimer = null

  /** The unsubscribe function of the arbitration point's subscription. */
  var offChange = null

  /** Whether the visibility listener is bound. */
  var visibilityBound = false

  /** Whether this surface's host is registered with the arbitration point. */
  var hostRegistered = false

  /** The elements whose removal is deferred to the end of the current release. */
  var deferredRemovals = []

  /** Whether a release is in progress (the change events during it are ignored). */
  var releasing = false

  /** The slot revision of the material that is on screen. */
  var lastRevision = -1

  /** The id of the material that is on screen. */
  var lastMediaId = null

  /** The options of the background, as they were read last. */
  var lastOptions = null

  /** What the last apply answered: 'applied' | 'skipped' | 'failed-kept-previous' | 'failed-released'. */
  var lastResult = null

  /** Whether the surface paused the material because the page went hidden. */
  var pausedForHidden = false

  /** Whether the stage is yielded to the other wallpaper plugin. */
  var yielding = false

  /** Whether a re-evaluation is already running. */
  var busy = false

  /** Whether the missing-arbitration-point warning was already printed. */
  var warned = false

  /**
   * The CSS that makes the host's surfaces transparent.
   *
   * ★ THE FRAME'S CLASS IS HASHED ⇒ SUBSTRING MATCH ONLY.
   *
   * `[class*="_frame"]` matches the hashed frame class whatever it is called
   * today. A substring match on `frame` alone would also match classes this
   * build uses for something else, and a full hashed name would break on the
   * next build.
   *
   * @returns the CSS text.
   */
  function transparentCss() {
    // ★ THE PANELS ARE PAINTED BY `--dsw-static-neutral-bluish-00` AND BY THE
    // `--dsw-alias-bg-layer-1/2/3` STACK. Measured in a browser against the
    // real host, not guessed: the conversation panel, the message bubbles and
    // the cards are painted by them, and they are the reason the media was
    // visible in the sidebar and NOWHERE ELSE. This plugin overrode
    // `--dsw-alias-bg-base` from the start, and that one paints almost
    // nothing.
    //
    // ★ THE VALUES ARE WRITTEN OUT, NOT DERIVED. An earlier version used
    // `color-mix(in srgb, var(--dsw-static-neutral-bluish-00) …, transparent)`
    // to keep the original colour, and that was a CSS CYCLE: the override
    // lived on the body and its own value read the property it was replacing.
    // A cycle makes the variable invalid at computed-value time, and an
    // invalid variable makes every `background-color` that reads it fall back
    // to TRANSPARENT — so the whole interface went see-through, which is the
    // exact bug this plugin was written to avoid. The originals are written
    // out here instead, one rule per theme, and nothing reads itself.
    //
    // ★ THE DARK THEME HAS ITS OWN NUMBERS, measured the same way.
    const panel = 'var(--dsham-l-surface,0.78)'
    // ★ THE SIDEBAR USES THE PANEL'S ALPHA, NOT A SECOND ONE.
    //
    // The sidebar was given its own, slightly MORE opaque value, so the
    // navigation column showed less of the media than the rest of the window
    // and read as a washed-out patch beside it. One knob, one veil: the whole
    // window shows the same amount of the media, and the sidebar keeps only
    // the host's own colour difference (#f9fafb against #fff), which is six
    // units of blue and invisible under a moving picture.
    const sidebar = 'var(--dsham-l-surface,0.78)'
    return [
      'html[data-dsham-bg="on"], html[data-dsham-bg="on"] body{background-color:transparent !important;}',
      'html[data-dsham-bg="on"] body{'
        + '--dsw-static-neutral-bluish-00:rgba(255,255,255,' + panel + ') !important;'
        + '--dsw-alias-bg-layer-1:rgba(255,255,255,' + panel + ') !important;'
        + '--dsw-alias-bg-layer-2:rgba(255,255,255,' + panel + ') !important;'
        + '--dsw-alias-bg-layer-3:rgba(255,255,255,' + panel + ') !important;'
        + '--dsw-alias-bg-base:rgba(255,255,255,' + panel + ') !important;'
        + '--dsw-specific-sidebar-fill:rgba(249,250,251,' + sidebar + ') !important;'
        + '}',
      'html[data-dsham-bg="on"] body[data-ds-dark-theme]{'
        + '--dsw-static-neutral-bluish-00:rgba(255,255,255,' + panel + ') !important;'
        + '--dsw-alias-bg-layer-1:rgba(35,35,36,' + panel + ') !important;'
        + '--dsw-alias-bg-layer-2:rgba(44,44,46,' + panel + ') !important;'
        + '--dsw-alias-bg-layer-3:rgba(53,54,56,' + panel + ') !important;'
        + '--dsw-alias-bg-base:rgba(21,21,23,' + panel + ') !important;'
        + '--dsw-specific-sidebar-fill:rgba(27,27,28,' + sidebar + ') !important;'
        + '}',
    ].join('\n')
  }

  /**
   * The CSS of the layer, of the media inside it and of the mask.
   *
   * ★ THE MEDIA IS STYLED ONLY INSIDE THE LAYER. The adapter gives every
   * media element the same class, and the other surfaces (the boot screen,
   * the screensaver) use it too ⇒ a rule on the class itself would restyle
   * their overlays as well.
   *
   * ★ `z-index: 0`, NEVER A NEGATIVE VALUE.
   *
   * @returns the CSS text.
   */
  function layerCss() {
    return [
      '.dsham-bg-layer{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;}',
      '.dsham-bg-layer .dsham-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}',
      '.dsham-bg-mask{position:absolute;inset:0;background:#fff;opacity:0;}',
      'body[data-ds-dark-theme] .dsham-bg-mask{background:#000;}',
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
   * ★ THIS IS A READ. The markers belong to the other plugins: they are
   * read, they are never written, and they are never removed.
   *
   * ★ TWO MARKERS, TWO PLUGINS.
   *
   *   `data-we-wallpaper` on the BODY — the public convention of the
   *   wallpaper plugin that ships with this host. It READS it to know that
   *   somebody else is on the stage, and it WRITES it while it is there.
   *
   *   `data-dsvs-background` on the ROOT element — the read-only marker the
   *   other wallpaper plugin exposes FOR OTHERS ("对外暴露只读标记：别的壁纸
   *   插件据此避让"). It is written on the root element, not on the body.
   *
   * ★ BOTH ARE CHECKED, because they come from different plugins, and
   * checking only one of them means the two backgrounds overlap during the
   * period when both plugins are installed. Two backgrounds on the stage at
   * once is exactly the "everything is covered" failure this surface had
   * once.
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
   * Whether the page is hidden right now.
   * @returns true when the page is hidden.
   */
  function pageIsHidden() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return false
    if (doc.visibilityState === 'hidden') return true
    return doc.hidden === true
  }

  /**
   * How many video elements are on the page.
   * @returns the count.
   */
  function countVideos() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return 0
    if (typeof doc.querySelectorAll !== 'function') return 0
    var found
    try {
      found = doc.querySelectorAll('video')
    } catch (error) {
      return 0
    }
    if (found === undefined || found === null) return 0
    return typeof found.length === 'number' ? found.length : 0
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
   * The attribute that says "the media is on the stage".
   *
   * ★ IT IS ON THE **ROOT** ELEMENT, NOT ON THE BODY.
   *
   * The body carries another plugin's marker and this plugin never writes on
   * the body. The root element is ours.
   *
   * @type {string}
   */
  var BACKGROUND_MARKER = 'data-dsham-bg'

  /**
   * Say that the media is on the stage.
   *
   * The theme-alias overrides in `transparentCss()` are scoped to this
   * attribute, so they only apply while the media is actually there. Without
   * it the interface would stay translucent after the media left.
   *
   * @returns true when the marker is on the root element.
   */
  function setBackgroundMarker() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return false
    var root = doc.documentElement
    if (root === undefined || root === null) return false
    if (typeof root.setAttribute !== 'function') return false
    try {
      root.setAttribute(BACKGROUND_MARKER, 'on')
    } catch (error) {
      return false
    }
    return true
  }

  /**
   * Take the marker off the root element again.
   *
   * @returns true when the marker is gone.
   */
  function removeBackgroundMarker() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return false
    var root = doc.documentElement
    if (root === undefined || root === null) return false
    if (typeof root.removeAttribute !== 'function') return false
    try {
      root.removeAttribute(BACKGROUND_MARKER)
    } catch (error) {
      return false
    }
    return true
  }

  /**
   * Put the style element on the page.
   *
   * ★ THE MARKER GOES ON WITH IT. The theme aliases are only overridden
   * while the marker is on the root element ⇒ the marker and the style are
   * installed together and removed together.
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
    element.textContent = transparentCss() + '\n' + layerCss()
    parent.appendChild(element)
    styleElement = element
    setBackgroundMarker()
    return styleElement
  }

  /**
   * Put the layer on the page.
   *
   * ★ THE LAYER GOES IN **FIRST**, NOT LAST.
   * `body.insertBefore(layer, body.firstChild)` — the same thing the
   * wallpaper plugin that ships with this host does. Two reasons, and the
   * second one is the one that matters:
   *
   *   1. the host's own root element is `position: fixed; z-index: 1000`
   *      and is appended to the body LAST, so a layer appended after it
   *      would be its DOM sibling and could end up in front of it;
   *   2. ★★ the layer is `z-index: -1` (see `layerCss()`), so it paints
   *      BELOW every in-flow element — including the portals the host
   *      mounts directly on the body. Appending it last would not change
   *      that, but inserting it first makes the intent obvious and makes
   *      the layer the FIRST thing the host's own CSS sees.
   *
   * ★ THE BODY IS ONLY INSERTED INTO. No attribute, no class and no inline
   * style is written on it — the marker that lives on the body belongs to
   * another plugin.
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
    layer.className = 'dsham-bg-layer'
    var mask = doc.createElement('div')
    mask.className = 'dsham-bg-mask'
    layer.appendChild(mask)
    if (typeof body.insertBefore === 'function') {
      // ★ `body.firstChild` may be null, and `insertBefore(node, null)` is
      // exactly `appendChild(node)` — so this one call covers both cases and
      // there is no second path that could put the layer somewhere else.
      body.insertBefore(layer, body.firstChild)
    } else {
      body.appendChild(layer)
    }
    layerElement = layer
    maskElement = mask
    return layerElement
  }

  /**
   * The host interface the arbitration point uses for THIS slot.
   *
   * The element lands inside the layer, and it leaves the page during the
   * LAST step of a FULL release — not before the observer and the timer are
   * done.
   *
   * ★ IT ALSO CARRIES `ensure()` AND `resolve()`.
   *
   *   `ensure()`   make sure the layer (and its style) is there. The
   *                arbitration point asks before it mounts, because a
   *                release takes the layer away.
   *   `resolve()`  turn a media id into the catalog entry that carries the
   *                media URL. The arbitration point remembers ids, not
   *                URLs; the entry is this surface's business.
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
        // The layer's rule says the same thing, but a media element that
        // loses its positioning rule must not fall back into the document
        // flow — that is what put the background below the viewport.
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
        var target = layerElement
        if (target === undefined || target === null) {
          var body = globalThis.document ? globalThis.document.body : null
          if (body !== undefined && body !== null) body.appendChild(element)
          return
        }
        target.appendChild(element)
      },
      unmount: function (element) {
        // ★ A SWITCHED MATERIAL LEAVES THE PAGE RIGHT NOW.
        //
        // The contract says one video at a time, and an element whose source
        // is still attached keeps downloading. Only a FULL release defers
        // the removal: there the contract puts "remove the elements" last,
        // after the observer and the timer are done.
        if (releasing !== true) {
          removeElement(element)
          return
        }
        deferredRemovals.push(element)
      },
      // ★ MAKE SURE THE LAYER IS THERE.
      //
      // The arbitration point asks before it mounts anything. A release
      // takes the layer away, so the next material has to have it built
      // again — here, and only here.
      ensure: function () {
        if (ensureStyle() === null) return null
        if (ensureLayer() === null) return null
        applyOptions(lastOptions)
        ensureRunning()
        return true
      },
      // ★ THE ENTRY COMES FROM THE CATALOG, NEVER FROM A HAND-WRITTEN URL.
      resolve: function (mediaId) { return resolveEntry(mediaId) },
    }
  }

  /**
   * Register this surface's host with the arbitration point, for its slot.
   *
   * ★ THE REGISTRATION IS PER SLOT AND IT IS NOT A GLOBAL SWAP. It stays
   * registered for as long as the surface lives, so the arbitration point's
   * own `apply()` mounts the material into the same layer.
   *
   * ★ A RELEASE DOES NOT FORGET IT. A release takes the LAYER away, and the
   * layer is built again when the next material asks for it — the host's
   * `ensure()` does that. A registration that died with the layer would
   * leave the next material with no host at all, and it would end up on the
   * body, where it is invisible.
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

  /**
   * Take the media off the page.
   *
   * The arbitration point releases it, and the adapter tears it down in its
   * own order: pause, clear the source, unbind the listeners.
   */
  function releaseMedia(displaced) {
    var controller = arbitrationPoint()
    if (controller === null) return
    // ★ TWO DIFFERENT MEANINGS, TWO DIFFERENT CALLS.
    //
    // A release says "this slot will not play again" — the user turned it
    // off. A displacement says "somebody else needs the stage for now" —
    // the slot stays enabled and the arbitration point brings it back.
    //
    // ★ THE YIELDING PATH MUST NOT USE `release()`. `release()` hands the
    // stage over right away, and the hand-over would drag a boot clip or a
    // screensaver onto the screen at the exact moment another wallpaper
    // plugin is taking over.
    if (displaced === true && typeof controller.displace === 'function') {
      try {
        controller.displace(SLOT)
      } catch (error) {
        // The arbitration point does not know about displacements yet.
        controller.release(SLOT)
      }
      return
    }
    controller.release(SLOT)
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
   * Remove the surface's own elements.
   *
   * ★ THIS IS THE LAST STEP OF THE RELEASE.
   */
  function removeOurElements() {
    flushDeferredRemovals()
    removeElement(layerElement)
    removeElement(styleElement)
    // ★ The marker on the root element goes with the style: while it is
    // there, the theme aliases are overridden; while the media is on the
    // stage, they have to be.
    removeBackgroundMarker()
    layerElement = null
    maskElement = null
    styleElement = null
    mediaElement = null
  }

  /**
   * Release the background.
   *
   * @param full - true when the whole surface goes away (the page is hidden);
   *   false when only the media and the elements go (somebody else is on the
   *   stage and this surface keeps watching).
   */
  function releaseBackground(full, displaced) {
    // ★ ONE RELEASE AT A TIME. The arbitration point publishes a change while
    // it releases, and that change must not start a second teardown in the
    // middle of this one.
    if (releasing === true) return
    releasing = true
    try {
      // ① the media: pause → clear the source → unbind its listeners.
      //    ★ `displaced` says whether this is a hand-over to somebody else
      //    (the slot comes back) or a release for good.
      releaseMedia(displaced)
      if (full === true) {
        // ② this surface's own listeners.
        if (offChange !== null) {
          try { offChange() } catch (error) { /* the subscription is best effort */ }
          offChange = null
        }
        if (visibilityBound === true) {
          var doc = globalThis.document
          if (doc !== undefined && doc !== null && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('visibilitychange', onVisibilityChange)
          }
          visibilityBound = false
        }
        // ③ the observer.
        if (observer !== null) {
          try { observer.disconnect() } catch (error) { /* the observer is best effort */ }
          observer = null
        }
        // ④ the timer.
        if (pollTimer !== null) {
          if (typeof globalThis.clearInterval === 'function') globalThis.clearInterval(pollTimer)
          pollTimer = null
        }
      }
      // ⑤ the elements.
      removeOurElements()
      // ★ THE HOST IS NOT FORGOTTEN. A release takes the LAYER away, and the
      // layer is built again when the next material asks for it — the host's
      // `ensure()` does that. A registration that died with the layer would
      // leave the next material without a host, and it would end up on the
      // body, where it is invisible.
      lastMediaId = null
      // ★ THE REVISION IS KEPT. It says "this setting is already on screen";
      // forgetting it would make the surface apply the material again right
      // after a release — which is exactly what the release was for.
    } finally {
      releasing = false
    }
    reportFacts()
  }

  /**
   * Give the stage to the other wallpaper plugin.
   *
   * ★ THE STAGE GOES CLEAN: the media, the layer and the injected style all
   * go. The other plugin cleans up after itself, and it must not find our
   * leftovers.
   *
   * ★ THE WATCHER STAYS. The observer, the poll and the subscription are
   * the ears that hear the other plugin leave the stage again — and the
   * background has to come back ON ITS OWN. A full release would take the
   * ears with it, and then nobody would know that the stage is free again.
   *
   * ★ THE SLOT IS NOT TOUCHED. The user did not turn the background off:
   * the slot stays enabled, with the same material, and it is not a release
   * on purpose either. A pushed-off slot comes back; a slot that was
   * released on purpose stays released.
   */
  function yieldStage() {
    if (yielding === true) return
    yielding = true
    // ★ THE QUIET RELEASE. It takes the media, the layer and the style away
    // and leaves the observer, the poll and the subscription alone.
    // ★ `true` says: this is a DISPLACEMENT — the slot was pushed off, not
    // turned off, and the arbitration point brings it back.
    releaseBackground(false, true)
    // ★ THE MATERIAL IS NOT "ON SCREEN" ANY MORE. The revision that said so
    // is forgotten, so the next evaluation applies it again — with the
    // material the configuration names right now, not the one from before.
    lastRevision = -1
  }

  /**
   * The other plugin left the stage: the background comes back.
   *
   * ★ THE ARBITRATION POINT DOES THE PLAYING. The surface asks it to apply
   * this slot again, and the arbitration point mounts the material in the
   * layer the surface builds again for it — the same road every other
   * material takes. There is no second road.
   *
   * ★ NOBODY HAS TO DO ANYTHING. Not a button, not a reload: the marker is
   * gone, the surface hears it, and the background is back.
   */
  function restoreAfterYield() {
    yielding = false
    // ★ ONE ROAD FOR THE COMEBACK — THE ARBITRATION POINT'S.
    //
    // The surface does not decide who comes back and in which order: the
    // arbitration point does, with its own priority list. A surface that
    // decided that by itself would be a second rulebook, and two rulebooks
    // disagree — that is how a boot clip ends up on top of a screensaver.
    var controller = arbitrationPoint()
    if (controller !== null && typeof controller.restore === 'function') {
      try {
        var result = controller.restore()
        if (result !== undefined && result !== null && typeof result.then === 'function') {
          return result
        }
        return Promise.resolve(null)
      } catch (error) {
        // The arbitration point does not know about restorations yet.
      }
    }
    return refresh()
  }

  /**
   * Publish this surface's own facts into the arbitration point's state.
   */
  function reportFacts() {
    var controller = arbitrationPoint()
    if (controller === null) return
    if (typeof controller.report !== 'function') return
    try {
      controller.report(SLOT, { hidden: pageIsHidden(), videoCount: countVideos() })
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
      // ★ THE OTHER PLUGIN CLAIMED THE STAGE ⇒ THIS SURFACE GOES AWAY.
      //
      // ★ THE STAGE GOES CLEAN: the media, the layer, the injected style,
      // all of it. The other plugin cleans up after itself, and it must not
      // find our leftovers.
      //
      // ★ AND THE EARS STAY — this observer IS the ear. It keeps watching,
      // so it also hears the moment the other plugin leaves again.
      if (anotherWallpaperIsOnStage()) {
        yieldStage()
        return
      }
      // ★ THE OTHER PLUGIN LEFT THE STAGE ⇒ THE BACKGROUND COMES BACK.
      //
      // The arbitration point applies it again, in the layer that is built
      // again for it. Nobody presses a button and nobody reloads the page.
      if (yielding === true) restoreAfterYield()
    })
    try {
      observer.observe(body, { attributes: true })
    } catch (error) {
      observer = null
    }
  }

  /**
   * Arm the surface's machinery: the subscription, the listener, the observer
   * and the timer.
   */
  function ensureRunning() {
    var controller = arbitrationPoint()
    if (controller === null) {
      warnOnce('没有仲裁点，背景表面不注册。')
      return false
    }
    // ★ THE HOST IS REGISTERED FIRST. Whoever asks for the background — this
    // surface or the arbitration point itself — gets the material inside
    // this surface's layer.
    registerMediaHost()
    if (offChange === null) {
      try {
        offChange = controller.on('change', onChange)
      } catch (error) {
        offChange = null
      }
    }
    var doc = globalThis.document
    if (visibilityBound !== true && doc !== undefined && doc !== null
      && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange)
      visibilityBound = true
    }
    ensureObserver()
    if (pollTimer === null && typeof globalThis.setInterval === 'function') {
      pollTimer = globalThis.setInterval(function () { refresh() }, POLL_MS)
    }
    return true
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
    var current = payload.state
    var stage = current !== undefined && current !== null ? current.slot : null
    var slots = current !== undefined && current !== null && current.slots !== undefined && current.slots !== null
      ? current.slots : {}
    var mine = slots[SLOT]
    var enabled = mine !== undefined && mine !== null && mine.enabled === true

    // ★ THE BACKGROUND IS NOT ON THE STAGE ⇒ OUR LAYER AND OUR CSS GO TOO.
    //
    // The arbitration point releases the background when the slot is turned
    // off, when another surface takes the stage, or when the user picks
    // another clip. A transparent shell with nothing behind it is a broken
    // interface, not an off switch ⇒ the layer and the injected style leave
    // with the material.
    if (stage !== SLOT && (layerElement !== null || mediaElement !== null)) {
      releaseBackground(false)
      return
    }
    // ★ THE SLOT IS OFF ⇒ THE LAYER AND THE CSS GO WITH IT.
    if (enabled !== true) {
      if (layerElement !== null || mediaElement !== null) releaseBackground(false)
      return
    }
    var changed = Array.isArray(payload.changed) ? payload.changed : []
    if (changed.indexOf(SLOT) === -1 && payload.optionsChanged !== true) return
    refresh()
  }

  /**
   * Pause the material that is on screen.
   * @returns true when the material was paused.
   */
  function pauseMedia() {
    var controller = arbitrationPoint()
    if (controller === null) return false
    if (typeof controller.pause !== 'function') return false
    try {
      return controller.pause(SLOT) === true
    } catch (error) {
      return false
    }
  }

  /**
   * Continue the material that is on screen.
   * @returns true when the material was continued.
   */
  function resumeMedia() {
    var controller = arbitrationPoint()
    if (controller === null) return false
    if (typeof controller.resume !== 'function') return false
    try {
      return controller.resume(SLOT) === true
    } catch (error) {
      return false
    }
  }

  /**
   * Whether the background should be paused while the page is hidden.
   *
   * ★ THE OPTION IS READ AT RUNTIME. `pauseWhenHidden` is true by default.
   *
   * @param group - the background's options.
   * @returns true when the background pauses instead of being released.
   */
  function pauseWhenHidden(group) {
    var options = group !== undefined && group !== null && typeof group === 'object' ? group : {}
    return options.pauseWhenHidden !== false
  }

  /**
   * The page became visible or hidden.
   */
  function onVisibilityChange() {
    if (pageIsHidden()) {
      // ★ HIDDEN MEANS PAUSED, NOT RELEASED. Releasing would mean streaming
      // and decoding the background again when the user comes back.
      if (pauseWhenHidden(lastOptions) === true) {
        pausedForHidden = pauseMedia()
      }
      reportFacts()
      return
    }
    // The page is visible again ⇒ continue where it left off.
    if (pausedForHidden === true) {
      pausedForHidden = false
      resumeMedia()
      reportFacts()
    }
    ensureRunning()
    refresh()
  }

  /**
   * Find one entry in the catalog.
   * @param entries - the catalog's entries.
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
   * Turn a media id into the catalog entry that carries the media URL.
   *
   * ★ THE ARBITRATION POINT REMEMBERS IDS, NOT URLS. It asks the surface
   * that owns the slot, and the surface answers with the entry the catalog
   * published — the URL is never built by hand.
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
   * Read the catalog.
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
   * Push the options onto the mask.
   *
   * ★ THE OPTIONS ARE READ AT RUNTIME. The mask's opacity is what the user
   * just configured, not a number this file carries.
   *
   * ★ TWO KNOBS, TWO DIFFERENT THINGS.
   *
   *   `surface` — the veil OVER the media (a white/black sheet on top of
   *               the video). 0 = the media is crisp, 1 = it is hidden.
   *   `panel`   — how opaque the application's OWN panels are over the
   *               media. 1 = the panels are solid, 0.3 = the media shines
   *               through them.
   *
   * ★ THE PANEL VALUE IS THE ONE THAT MATTERS FOR COMFORT. The panels carry
   * the text the user reads; a moving picture under text is tiring, and the
   * first real-machine test said exactly that. The default is 0.86 — the
   * media is a faint tint behind the text, and the text is easy to read.
   *
   * ★ THE SIDEBAR GETS A SLIGHTLY OPAQUE FILL: it carries the workspace
   * and session names against a moving picture, and it is the surface the
   * user complained about first.
   *
   * @param group - the background's options.
   */
  function applyOptions(group) {
    lastOptions = group
    var options = group !== undefined && group !== null && typeof group === 'object' ? group : {}
    var surface = typeof options.surface === 'number' && isFinite(options.surface) ? options.surface : 0
    if (surface < 0) surface = 0
    if (surface > 1) surface = 1
    // ★ The panel opacity. The fallback is the same 0.78 the schema declares,
    // so a profile whose host has not been restarted yet (and therefore does
    // not know the field yet) still gets the intended value instead of a
    // half-transparent one.
    var panel = typeof options.panel === 'number' && isFinite(options.panel) ? options.panel : 0.78
    if (panel < 0.3) panel = 0.3
    if (panel > 1) panel = 1
    var doc = globalThis.document
    var root = doc !== undefined && doc !== null ? doc.documentElement : null
    if (root !== undefined && root !== null && typeof root.style === 'object' && root.style !== null) {
      try {
        root.style.setProperty('--dsham-l-surface', String(panel))
      } catch (error) {
        /* the custom properties are best effort */
      }
    }
    if (maskElement === null) return
    try {
      maskElement.style.opacity = String(surface)
    } catch (error) {
      /* the mask is best effort */
    }
  }

  /**
   * Play one entry.
   * @param entry - the catalog entry.
   * @returns what the arbitration point answered.
   */
  function applyEntry(entry) {
    var controller = arbitrationPoint()
    if (controller === null) {
      warnOnce('没有仲裁点，背景表面不注册。')
      return 'no-arbitration-point'
    }
    // ★ THE ELEMENTS THAT WAITED FOR THEIR TURN GO NOW. A material that was
    // released while nobody was looking must not pile up in the layer.
    flushDeferredRemovals()
    // ★ THE ARBITRATION POINT IS THE ONLY PATH TO THE MEDIA — and it asks
    // this surface for its host first, so the layer is there and the element
    // lands inside it. There is no second way to play anything.
    var result = controller.apply(SLOT, entry)
    lastResult = typeof result === 'string' ? result : 'applied'
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
    return readSlots().then(function (payload) {
      var config = payload.config
      var slots = config.slots !== undefined && config.slots !== null ? config.slots : {}
      var group = slots[SLOT]
      var slot = group !== undefined && group !== null && typeof group === 'object' ? group : {}
      var options = config.options !== undefined && config.options !== null ? config.options : {}
      var backgroundOptions = options[SLOT]

      // ★ THE SURFACE'S MACHINERY IS ARMED FIRST.
      //
      // Even when nothing plays, the surface keeps watching: the other
      // plugin may leave the stage, and the user may turn the slot back on.
      if (ensureRunning() === false) return null

      // ★ THE OTHER PLUGIN IS ON THE STAGE ⇒ THIS SURFACE GOES AWAY.
      //
      // ★ THE QUIET RELEASE: the stage is handed over clean — the media,
      // the layer, the injected style — and the watcher stays, so the
      // background comes back on its own when the stage is free again.
      if (anotherWallpaperIsOnStage()) {
        yieldStage()
        return null
      }
      // ★ THE OTHER PLUGIN LEFT THE STAGE ⇒ THE YIELDING IS OVER. The
      // background is allowed back, and the arbitration point applies it
      // below — the same road every other material takes.
      yielding = false

      // The page is hidden ⇒ nothing plays.
      if (pageIsHidden()) return null

      var enabled = slot.enabled === true
      var mediaId = typeof slot.mediaId === 'string' && slot.mediaId !== '' ? slot.mediaId : null
      var revision = typeof slot.revision === 'number' ? slot.revision : -1

      if (enabled !== true || mediaId === null) {
        if (layerElement !== null || mediaElement !== null) releaseBackground(false)
        return null
      }

      applyOptions(backgroundOptions)

      // ★ SOMEBODY ELSE IS ON THE STAGE ⇒ THE BACKGROUND WAITS.
      //
      // The priority (boot > screensaver > background) is the arbitration
      // point's rule: the background never takes the stage away from a clip
      // that is playing. The arbitration point hands the stage back when it
      // is free again — one hand-over, and the surfaces never have to know
      // about each other.
      var stage = null
      var controller = arbitrationPoint()
      if (controller !== null && typeof controller.state === 'function') {
        try {
          var snapshot = controller.state()
          stage = snapshot !== undefined && snapshot !== null ? snapshot.slot : null
        } catch (error) {
          stage = null
        }
      }
      if (stage !== null && stage !== undefined && stage !== SLOT) return null

      // ★ ALREADY ON THE STAGE ⇒ NOTHING TO DO.
      //
      // The arbitration point may have applied this material itself — that
      // is how a pushed-off slot comes back. Applying it a second time
      // would take the video down and start it over.
      if (stage === SLOT && controller !== null && typeof controller.state === 'function') {
        var snapshot = null
        try {
          snapshot = controller.state()
        } catch (error) {
          snapshot = null
        }
        if (snapshot !== undefined && snapshot !== null
          && snapshot.playing === true && snapshot.mediaId === mediaId) {
          lastRevision = revision
          return null
        }
      }

      // ★ THE MATERIAL IS APPLIED WHEN THE SETTING MOVED.
      //
      // A release from the outside — the arbitration point, or another
      // surface that took the stage — is respected until the user changes the
      // setting. Re-applying right away would put the background back under
      // the surface that just took over, and would undo the teardown.
      if (revision === lastRevision) return null

      return readCatalog().then(function (catalog) {
        var entries = catalog.entries
        var entry = findEntry(entries, mediaId)
        if (entry === null) {
          // ★ THE MATERIAL CANNOT BE RESOLVED ⇒ THAT IS A FAILURE, NOT A
          // "SKIP". The caller has to be able to tell "nothing to do" from
          // "it failed and the old one stayed".
          //
          // ★ AND THE OLD MATERIAL STAYS. A failed switch must not take the
          // background off the screen.
          lastResult = 'failed-kept-previous'
          return lastResult
        }
        lastMediaId = mediaId
        lastRevision = revision
        applyEntry(entry)
        return lastResult
      })
    }).catch(function (error) {
      warnOnce('读不到背景配置：' + String(error !== undefined && error !== null && error.message
        ? error.message
        : error))
      return null
    }).then(function (result) {
      busy = false
      return result
    })
  }

  /**
   * The surface's own state.
   * @returns the facts.
   */
  function state() {
    // ★ THE MATERIAL THAT IS ON THE STAGE. After a hand-over the surface
    // did not apply anything itself, so the arbitration point's own truth
    // is the one that says what is playing.
    var id = lastMediaId
    var controller = arbitrationPoint()
    if (controller !== null && typeof controller.state === 'function') {
      try {
        var snapshot = controller.state()
        if (snapshot !== undefined && snapshot !== null && snapshot.slot === SLOT
          && typeof snapshot.mediaId === 'string') {
          id = snapshot.mediaId
        }
      } catch (error) {
        /* the arbitration point's truth is best effort */
      }
    }
    return {
      layer: layerElement !== null,
      media: mediaElement !== null,
      hidden: pageIsHidden(),
      videoCount: countVideos(),
      mediaId: id,
      revision: lastRevision,
      lastResult: lastResult,
    }
  }

  globalThis.__DSH_APPEARANCE_BACKGROUND__ = {
    version: '0.1.0',
    available: arbitrationPoint() !== null,
    state: state,
    refresh: refresh,
    // ★ THE SAME PATH THE SURFACE ITSELF USES: the arbitration point does
    // the mounting, and the layer's host is registered for this slot ⇒ the
    // material lands inside the layer.
    apply: function (entry) { return applyEntry(entry) },
    release: function () { releaseBackground(true) },
    // ★ THE END OF THE SURFACE. The stage goes clean and the host is
    // forgotten — the one thing a release does NOT do, because a release
    // only takes the layer away.
    dispose: function () {
      releaseBackground(true)
      unregisterMediaHost()
    },
  }

  // ★ THE SURFACE STARTS ONLY WITH AN ARBITRATION POINT.
  //
  // No arbitration point ⇒ no surface: the surface warns once and touches
  // nothing. It never becomes an arbitration point of its own.
  if (arbitrationPoint() === null) {
    warnOnce('没有仲裁点，背景表面不注册。')
  } else {
    ensureRunning()
    refresh()
  }
})()
