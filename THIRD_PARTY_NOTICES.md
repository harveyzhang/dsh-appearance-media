# Third-party notices

`dsh-appearance-media` is distributed under the MIT License (see [LICENSE](LICENSE)).
The Host half, the browser half, the media routes and the arbitration point are
written against the public DSH plugin contracts. **The boot screen, the
screensaver surface and the lossless `moov` rewrite port code from
`dsh-boot-animation`**, which is MIT licensed: the code below is used under that
licence and the copyright notice is kept. The **material** of that project is
*not* MIT and is **not** included, redistributed or shipped here — see "Material"
below.

## Ported code

| Project | Author | Licence | What was ported |
|---|---|---|---|
| [dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation) | lxj5820 | MIT | The **boot screen** surface (`src/boot-screen.js`) and the **screensaver** surface (`src/screensaver.js`): the overlay structure, the `ENDLESS_MS` upper bound, the hold budget, the `onEnded` hand-over, the bounded wait for the clip manifest, the trigger rules of the screensaver, the cross-dissolve and the break-away effect. Copyright (c) 2026 dsh-boot-animation contributors. The **configuration model** was replaced by this package's slot model, and the **material** was not taken. |
| [dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation) | lxj5820 | MIT | The **lossless `moov`-to-front rewrite** (`lib/remux.js`, from the upstream's `src/remux.js`): the top-level box parser, the chunk-offset table scanner, the layout planner, the offset patcher, the output self-check and every one of the upstream's refusal rules (no `moov`, several `mdat` boxes, a layout that would leave `moov` after `mdat`, a layout that would not move `moov`, a missing chunk-offset table, a changed length, a changed media payload, an output that still places `moov` after `mdat`, a changed table count, a chunk offset that was not shifted correctly, and a 32-bit offset that would overflow). Copyright (c) 2026 dsh-boot-animation contributors. The upstream's copyright notice is kept verbatim in the ported file's header, and the two changes made in the port — the directory convention and the atomic swap — are listed in that header. No upstream code was reimplemented and no refusal rule was dropped. |

## Referenced upstream projects

| Project | Author | License | Relationship |
|---|---|---|---|
| [dsh-video-skin](https://github.com/Something11235/dsh-video-skin) | Something11235 | MIT | Read as a reference for the browser half: the lazy `window.__ModuleLoader__` CJS factory, the `settings.section` / `plugins.item` slot registrations, and the theme-token styling vocabulary. |
| [dsh-plugin-wallpaper-engine](https://github.com/elysia395/dsh-plugin-wallpaper-engine) | elysia395 | MIT | Read as a reference for the media-slot vocabulary (background / boot / screensaver) this package's configuration schema is named after. |

## Material

The video files of `dsh-boot-animation` (`assets/videos/`, `assets/screensaver/`)
are the author's own work and are **not** covered by the MIT licence. They are
**not** included in this package, not redistributed, and not sold. Users who
want that material import it into their own media library, for their own use.
This package ships **no** media of its own: `assets/` is empty by design.

## Media assets

**No upstream media (video, artwork, textures) is copied into this package, and
this package carries no third-party media at all.** The `assets/` directory is
empty and stays empty: every media file a future release plays must either be
supplied by the user into their own data directory, or be created by the user
for this plugin under a license that permits redistribution.

The only artwork shipped here is `icon.svg`, which is an original drawing made
for this package.

## Runtime dependencies

`@deepseek-ai/schemastery` is declared **twice**, and both declarations are
deliberate:

- as a **peer dependency** (`"*"`) — the Host supplies a copy of its own, and a
  plugin must not force a second one on a profile that already has it;
- as a **hard dependency** (`"3.19.0"`) — because a plugin installed from a
  local checkout into a profile that has no packages of its own cannot resolve
  the peer: Node's upward lookup from `<profile>/node_modules/<package>/` never
  reaches the Host application's own `node_modules`. Without the hard
  dependency, such a profile silently falls back to this package's built-in
  compatibility layer, and the plugin loses its settings namespace.

No copy of the library is vendored into this package; it is installed by the
package manager like any other dependency. The library itself is MIT-licensed
and its notice ships with the installed copy.

## Trademarks

DeepSeek Harness, DSH and Cordis are the property of their respective
owners. This package is an independent plugin and is not endorsed by them.
