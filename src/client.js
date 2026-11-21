// dsh-appearance-media — browser half.
//
// THREE contributions, each in the slot the HOST's contract names:
//
//   1. `settings.section` — the Settings page's left-hand entry. It renders a
//      SUMMARY of the media library.
//   2. `plugins.detail.section` — the section under THIS bundle's own page,
//      where the full media library lives: import, list, delete.
//   3. `plugins.bundle.config` — THIS bundle's configuration form, keyed by
//      the bundle's PACKAGE NAME. The host renders it on the bundle's own
//      page (`view: 'page'` only) and passes no form of its own, so the entry
//      supplies one through its `inject` face.
//
// ★ THE `plugins.detail.section` SLOT IS RENDERED ON OUR PACKAGE'S PAGE.
//
// The Host renders that slot in three places
// (`PluginManagerPage.tsx:667` / `:712` / `:838`), and the third one is
// `PackageDetail` — the page of the bundle you are looking at — with
// `subject = { kind: 'bundle', pkg: packageRef(pkg) }` (`:759`). So the guard
// judges the SUBJECT and nothing else:
//
//     subject.kind === 'bundle' && subject.pkg.name === 'dsh-appearance-media'
//
// ★ AND IT DOES NOT JUDGE `props.view`. That slot's owner props are
// `PluginDetailProps` = `{ subject }` (`slot-contract.ts:68-71`) — there IS no
// `view` prop. A guard that tested `props.view !== 'page'` would render
// NOTHING, forever, and every offline assertion would still be green.
//
// There is deliberately NO registration in the Official group's card slot
// (the one the host renders as an official plugin's card).
//
// That slot is the Official group's: the host renders it as a card of its own
// (`PluginManagerPage.tsx:611` renders the summary view into the card head,
// and the ledger turns every entry registered there into a second card —
// `config-ledger.ts:61` → `PluginManagerPage.tsx:1657`). A plain INSTALLED
// bundle already gets a card from the host, rendered from the bundle's own
// `locale/*.json` title, description and icon
// (`PluginManagerPage.tsx:1601`: `const mine = listed.filter(pkg => !pkg.official)`;
// the bundle is not on the host's hidden list — `dsh-official-bundles/src/
// plugin-manager.ts:24-33` — so its card is always rendered).
//
// Registering in that slot as well therefore produced TWO cards for the same
// plugin, with two different descriptions: ours and the host's. The host's
// card is the right one — it carries the icon and the description from the
// locale files — so this plugin takes only the three slots above.
//
// (The slot's name is written out in docs/DETAIL.md; the built artifact must
// not contain it, so that a stray registration cannot come back unnoticed.)
//
// FOUR THINGS THIS FILE DELIBERATELY DOES NOT DO:
//
//   1. It declares no `inject`. A required service leaves the client fiber
//      PENDING in a profile that lacks it, and then `apply` never runs at all.
//      The services are therefore reached with the dynamic
//      `ctx.inject(deps, callback)` form, which waits for them without gating
//      anything. The `dsh.client` section of package.json declares only
//      `platform`, for the same reason.
//
//   2. It requires nothing but `react`. `react` is a baseline module of the
//      host's browser bundle, so asking for it needs no declaration and no
//      build-time external. Every control here is a plain DOM element styled
//      with the host's theme tokens.
//
//   3. It never writes the profile's patch file. Every configuration write goes
//      through the HOST's form (`ConfigForm.set`), which is the host's own
//      write queue in front of its configuration editor. A plugin that writes
//      the patch itself bypasses every fence the host owns.
//
//   4. It never writes `body[data-we-wallpaper]`. That attribute is WE's and
//      P06's marker — WE's own JavaScript READS it
//      (`WE lib/client.js:22856` `body.hasAttribute("data-we-wallpaper")`),
//      and writing it would break their cleanup logic. This plugin only
//      READS it, and steps aside when it finds it set. The cost — the other
//      plugin does not step aside for us — is written down in docs/DETAIL.md as
//      a known limitation.

const React = require('react')
const h = React.createElement

/** The profile entry id; also the settings namespace the Host serves. */
const SETTINGS_NAMESPACE = 'appearance-media'

/** The bundle's package name: the key of the `plugins.bundle.config` slot. */
const PACKAGE_NAME = 'dsh-appearance-media'

/** The client dictionary namespace this panel's label is read from. */
const LOCALE_NAMESPACE = 'appearanceMedia'

/** The settings page's left-hand list slot. */
const SLOT_SECTION = 'settings.section'

/** The Plugins page's per-bundle card: the host renders one card per
 *  registered entry, with the bundle's icon, title and description, and asks
 *  the entry for its body. ★ THIS IS THE SLOT THE BOOT-ANIMATION PLUGIN
 *  USES, and it is the reason its card sits in the Plugins page next to the
 *  built-in ones while ours sat in the Settings page instead.
 */
const SLOT_PLUGIN_ITEM = 'plugins.item'

/** The section under this bundle's own page: where the media library lives. */
const SLOT_DETAIL_SECTION = 'plugins.detail.section'

/** The bundle's own configuration slot, keyed by the package name. */
const SLOT_BUNDLE_CONFIG = 'plugins.bundle.config'

/** This build's version, in step with package.json. */
const PLUGIN_VERSION = '0.1.0'

/**
 * The card's one-liner: what this plugin is FOR.
 *
 * ★ IT IS NOT THE SUMMARY. The summary answers the collapsed row in the
 * Plugins list, and the Host prints it there; this line answers the card's
 * own head. Two sentences that say the same thing in the same place is one
 * of the duplications this card used to suffer from.
 */
const CARD_DESCRIPTION = '背景、片头与屏保：素材与选项都在这里'

/** Where the Host publishes the media catalog. */
const CATALOG_URL = '/appearance-media/catalog.json'

/** Where the Host accepts an upload: the raw bytes, no form. */
const UPLOAD_URL = '/appearance-media/upload'

/**
 * Where the Host accepts the deletion of ONE material.
 *
 * ★ THE DELETE IS THE HOST'S WORK, AND IT IS A DELETE, NOT A POST.
 *
 *   `DELETE /appearance-media/media/<id>` — the id is in the path, because the
 *   thing being deleted IS the resource at that path. The Host takes the file
 *   out of the library, clears the slots that pointed at it, drops it out of
 *   the ledger, and only then unlinks the bytes.
 *
 * ★ AND THE ANSWER SAYS WHICH SLOTS MOVED. A material the background is
 *   playing is a material the user cannot delete without changing the
 *   background, and the card has to be able to say that out loud.
 */
const MEDIA_DELETE_URL = '/appearance-media/media/'

/**
 * Where the Host rewrites ONE material in place.
 *
 * ★ THE REWRITE IS THE HOST'S, NOT OURS. A browser cannot rewrite a file in
 * the media directory, so the card asks the Host — and the Host answers with
 * the entry it now holds, in the same shape the catalog publishes, so the row
 * can be redrawn with the size the file REALLY has. A card that guessed the
 * new size would print a number the catalog does not agree with.
 */
const OPTIMIZE_URL = '/appearance-media/optimize'

/** What the import picker offers. */
const ACCEPTED_TYPES = 'video/mp4,video/webm,video/ogg,image/jpeg,image/png,image/webp'

/** Chinese half of the dictionary. */
const DICTIONARY_ZH = {
  title: '外观媒体',
  dataDirLabel: '数据目录',
  dataDirHint: '留空表示默认目录；填绝对路径则覆盖它。',
  save: '保存',
  saving: '保存中…',
  saved: '已保存。',
  saveFailed: '保存失败（宿主拒绝了这次写入）。',
}

/** English half of the same dictionary. */
const DICTIONARY_EN = {
  title: 'Appearance media',
  dataDirLabel: 'Data directory',
  dataDirHint: 'Empty means the default directory; an absolute path overrides it.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved.',
  saveFailed: 'The save was refused by the Host.',
}

/**
 * The three media slots this plugin will own.
 *
 * `label` is Chinese on purpose: the panel's own copy is user-facing Chinese
 * in this build, while the SLOT LABEL is read from the locale service so it
 * follows the shell's language.
 */
const MEDIA_SLOTS = [
  { key: 'background', label: '背景' },
  { key: 'boot', label: '片头' },
  { key: 'screensaver', label: '屏保' },
]

/**
 * The locale reader, replaced when the locale service arrives.
 *
 * A slot entry with a `locale` option gets the host's own reader as a prop;
 * this is the fallback for a host that does not inject one.
 */
let translate = function (key) { return DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key] }

/**
 * Pick the reader to use.
 * @param props - the props the host rendered the entry with.
 * @returns the host's reader when it has one, the fallback otherwise.
 */
function reader(props) {
  if (props !== undefined && props !== null && typeof props.t === 'function') return props.t
  return translate
}

/**
 * Host theme tokens, so the panel follows light and dark by itself.
 *
 * ★ EVERY TOKEN CARRIES A LITERAL FALLBACK.
 *
 * A `var(--dsw-…)` with no fallback resolves to NOTHING on a page whose theme
 * has not loaded yet — and a border that resolves to nothing is a border that
 * is not there, so the card collapses into an unframed blob of text. The
 * fallback is the value the host itself uses for that role, so a themed page
 * and an unthemed one look the same.
 *
 * The token names are the ones the shipped Host actually declares
 * (`--dsw-alias-label-primary`, `--dsw-alias-border-l2`, `--dsw-alias-bg-layer-2`
 * and so on); nothing here invents a name.
 */
const C = {
  label: 'var(--dsw-alias-label-primary, inherit)',
  dim: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.95))',
  faint: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.85))',
  soft: 'var(--dsw-alias-label-dimmed, rgba(127,127,127,.5))',
  border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.22))',
  borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,.14))',
  borderStrong: 'var(--dsw-alias-border-l4, rgba(127,127,127,.34))',
  // ★ THE THREE SURFACE LAYERS, IN THE ORDER THE HOST NAMES THEM.
  //
  // `bg-layer-1` is the "primary raised surface", `bg-layer-2` the "secondary
  // nested surface" and `bg-layer-3` the deepest one. The card uses them from
  // the outside in — the card is the layer-3 surface, a group is the layer-2
  // one nested inside it, and an option is a raised tile on top of that.
  // In the light theme all three are the same white, so the SEPARATION comes
  // from the borders and from the tile wash; in the dark theme the three are
  // three different greys, and the card is the palest of them.
  layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
  layerRaised: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
  layerHigh: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.12))',
  brand: 'var(--dsw-alias-brand-primary, #4f9dd9)',
  // ★ THE BLUE ACCENT. `--dsw-alias-brand-primary` is the host's NEUTRAL brand
  // (near-black in the light theme, near-white in the dark one), so it cannot
  // carry the blue selection rail; this token is the brand's blue in both
  // themes (#4176e6 on light, rgb(86,134,254) on dark).
  accent: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6)',
  // The accent at a third of its strength — the bottom of the rail's gradient.
  accentSoft: 'color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6) 32%, transparent)',
  // ★ THE ACCENT AT FULL STRENGTH, AND A DEEPER ONE. The avatar's gradient
  // ends on a colour that is still OPAQUE: a gradient that fades to a
  // transparent stop makes the tile look like it is dissolving into the card.
  accentDeep: 'color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6) 72%, black)',
  // The accent as a wash — the tint on an open group.
  accentWash: 'color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6) 9%, transparent)',
  // ★ THE TILE. A six-percent wash of the SECONDARY label colour: a grey tile
  // on the light theme and a lifted tile on the dark one, from ONE token pair.
  // A hand-picked rgba would have to be different in each theme, and the
  // `color-mix` needs a colour token with a colour fallback — `inherit` is not
  // a colour and would make the whole declaration invalid.
  tile: 'color-mix(in srgb, var(--dsw-alias-label-secondary, rgba(127,127,127,.95)) 6%, transparent)',
  // The colour of a mark drawn ON the accent — the avatar's play triangle.
  onColor: 'var(--dsw-alias-label-on-color, #ffffff)',
  warn: 'var(--dsw-alias-state-warn-primary, #d2820b)',
  ok: 'var(--dsw-alias-state-success-primary, #07974b)',
  error: 'var(--dsw-alias-state-error-primary, #d24a43)',
}

/** Inline styles for the panel. */
const S = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    fontSize: '13px',
    color: C.label,
  },
  // ★ THE CARD. One surface, the palest of the three layers, with the head
  // on top of it and everything else nested inside.
  card: {
    border: '1px solid ' + C.borderStrong,
    borderRadius: '16px',
    backgroundColor: C.layerHigh,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  // ★ THE HEAD IS A BUTTON. It carries the avatar, the title, the one-liner,
  // the meta line and the chevron, and it folds the card — a chevron that
  // folds nothing is a lie told to the eye.
  cardHead: {
    width: '100%',
    appearance: 'none', background: 'none', border: 'none',
    padding: '14px 16px', margin: '0', font: 'inherit', color: 'inherit',
    textAlign: 'left', cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: '12px',
  },
  cardHeadText: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' },
  cardTitle: { fontSize: '15px', fontWeight: 600, color: C.label, lineHeight: '1.3' },
  cardDesc: { fontSize: '12.5px', color: C.faint, lineHeight: '1.45' },
  // ★ THE META LINE. The version and the library count used to live in a
  // whole card of their own; they are one small line at the head's right now.
  cardMeta: { flex: 'none', fontSize: '11px', color: C.faint, whiteSpace: 'nowrap' },
  // ★ THE AVATAR. A square rounded tile, 40px, drawn by the card itself.
  avatar: {
    flex: 'none', width: '40px', height: '40px', borderRadius: '11px',
    overflow: 'hidden', display: 'block', lineHeight: 0,
    border: '1px solid ' + C.borderSoft,
    backgroundColor: C.tile,
  },
  // The chevron: two borders and a rotation, exactly like the group's own.
  chev: {
    flex: 'none', width: '7px', height: '7px', marginRight: '2px',
    borderRight: '1.5px solid ' + C.faint,
    borderBottom: '1.5px solid ' + C.faint,
    transform: 'rotate(45deg)',
    transition: 'transform .18s ease',
  },
  chevOpen: { transform: 'rotate(225deg)' },
  cardBody: {
    padding: '0 16px 16px',
    display: 'flex', flexDirection: 'column', gap: '14px',
  },
  // ★ A PLAIN CARD, for the two panels that are not this card: the media
  // library and the configuration form. They have no head of their own, so
  // they carry their own padding — the card above has none, because its head
  // is what carries the inset.
  panelCard: {
    border: '1px solid ' + C.border,
    borderRadius: '12px',
    backgroundColor: C.layerRaised,
    padding: '14px 16px',
    display: 'flex', flexDirection: 'column', gap: '10px',
  },
  errorLine: { fontSize: '12px', lineHeight: '1.5', color: C.error },
  sectionTitle: { fontSize: '12.5px', fontWeight: 600, color: C.label },
  // ★ THE OVERVIEW STRIP: THREE PILLS, ONE PER SURFACE.
  //
  // ★ A PILL IS NOT A CONTROL. It used to carry a checkbox that said exactly
  // what the switch on the group's own row says, and two controls for one
  // fact is a gesture tax: the reader has to work out which one is real.
  // The switch on the group's row is the master — it is what turns the
  // surface on — so the pill only REPORTS, with a dot that says on or off.
  overview: {
    display: 'flex', flexWrap: 'wrap', gap: '8px',
  },
  overviewItem: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '8px 12px', borderRadius: '12px',
    border: '1px solid ' + C.border,
    backgroundColor: C.tile,
  },
  overviewItemOn: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '8px 12px', borderRadius: '12px',
    border: '1px solid ' + C.borderStrong,
    backgroundColor: C.layerRaised,
  },
  overviewName: { fontWeight: 600, fontSize: 13 },
  overviewMeta: {
    fontSize: 11, color: C.faint, maxWidth: 170,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  // The dot: the only mark that says whether the surface is on.
  dot: { flex: 'none', width: '8px', height: '8px', borderRadius: '50%' },
  dotOn: { backgroundColor: C.accent },
  dotOff: { backgroundColor: 'transparent', border: '1px solid ' + C.borderStrong },
  // ★ A COLLAPSIBLE GROUP: ONE SURFACE, ONE CARD, ONE RAIL.
  //
  // The head is one row: a chevron, the surface's name, the summary chip and
  // the master switch. The body is mounted only while the group is open, so a
  // closed group costs its summary and nothing else.
  //
  // ★ THE RAIL IS A BACKGROUND IMAGE, NOT A CHILD. A background is clipped by
  // the border radius for free; a child would poke out of the rounded corner
  // and need `overflow: hidden`, which would also clip the pool dialog this
  // card renders inside itself.
  group: {
    border: '1px solid ' + C.border,
    borderRadius: '12px',
    backgroundColor: C.layerRaised,
    backgroundImage: 'linear-gradient(180deg, ' + C.borderStrong + ', ' + C.borderSoft + ')',
    backgroundSize: '3px 100%',
    backgroundPosition: 'left top',
    backgroundRepeat: 'no-repeat',
    overflow: 'hidden',
    transition: 'border-color .18s ease, background-color .18s ease',
  },
  // ★ THE OPEN GROUP. The rail turns BLUE — the one mark that answers "which
  // section am I inside" — and the group takes a faint wash of the same blue.
  //
  // ★ NO `background` SHORTHAND HERE. The shorthand resets `background-size`
  // to `auto`, and the rail would then fill the whole card and paint it solid
  // blue over every label on it.
  groupOpen: {
    borderColor: C.borderStrong,
    backgroundImage: 'linear-gradient(180deg, ' + C.accent + ', ' + C.accentSoft + '),'
      + ' linear-gradient(180deg, ' + C.accentWash + ', ' + C.accentWash + ')',
    backgroundSize: '3px 100%, 100% 100%',
    backgroundPosition: 'left top, left top',
    backgroundRepeat: 'no-repeat, no-repeat',
  },
  groupHead: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '11px 13px',
  },
  groupHeadButton: {
    flex: '1 1 auto', minWidth: 0,
    display: 'flex', alignItems: 'center', gap: '10px',
    appearance: 'none', background: 'none', border: 'none',
    padding: '0', margin: '0', font: 'inherit', color: 'inherit',
    textAlign: 'left', cursor: 'pointer',
  },
  // The chevron: two borders and a rotation. It rotates in BOTH directions,
  // which is what makes a collapse feel like a movement rather than a cut.
  groupChev: {
    flex: 'none', width: '6px', height: '6px', marginRight: '2px',
    borderRight: '1.5px solid ' + C.faint,
    borderBottom: '1.5px solid ' + C.faint,
    transform: 'rotate(-45deg)',
    transition: 'transform .18s ease',
  },
  groupChevOpen: { transform: 'rotate(45deg)' },
  groupTitle: { fontSize: '13px', fontWeight: 600, color: C.label, flex: '0 0 auto' },
  // The summary is a CHIP, not loose grey text: loose text beside a bold
  // title competes with it.
  groupSummary: {
    flex: '0 1 auto', minWidth: 0, fontSize: '11px', color: C.dim,
    padding: '1px 9px', borderRadius: '999px',
    backgroundColor: C.tile,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  groupBody: {
    padding: '10px 13px 13px',
    borderTop: '1px solid ' + C.borderSoft,
    display: 'flex', flexDirection: 'column', gap: '10px',
  },
  // ★ ONE OPTION: ITS OWN CARD.
  //
  // The options used to be stacked inside one big sheet with nothing between
  // them, so the card read as a wall of text. Each option is a rounded plate
  // of its own, and the ten pixels between the plates are what let the eye
  // walk down the list.
  optionCard: {
    border: '1px solid ' + C.border,
    borderRadius: '10px',
    backgroundColor: C.tile,
    padding: '10px 12px',
    display: 'flex', flexDirection: 'column', gap: '8px',
  },
  // ★ ONE ITEM: THE TITLE, AND THE GREY LINE UNDER IT.
  //
  // Two lines, always: what the option is called, and what it does — with
  // the DIRECTION spelled out, because a number nobody can read the meaning
  // of is a knob they cannot use. The two lines live in `itemText`; the plate
  // around them is `optionCard`.
  itemHead: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  itemText: { flex: '1 1 auto', minWidth: 0 },
  itemTitle: { fontSize: '12.5px', fontWeight: 600, color: C.label, display: 'block' },
  itemHint: { fontSize: '11.5px', color: C.faint, display: 'block', marginTop: '2px', lineHeight: '1.5' },
  itemAside: { flex: 'none', display: 'flex', alignItems: 'center', gap: '8px' },
  itemControl: { display: 'flex', flexDirection: 'column', gap: '8px' },
  itemStack: { display: 'flex', flexDirection: 'column', gap: '10px' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: '10px' },
  value: { fontSize: '11.5px', color: C.dim, minWidth: '34px', textAlign: 'right' },
  // ★ THE CHOICE TILES: a grid of button cards.
  //
  // A grid and not a row of pills, because three choices (进入方式) then read
  // as three BIG cards and five choices (淡入时长) as five smaller ones, both
  // from the same rule — and a long label can never make one tile wider than
  // the others.
  choices: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(76px, 1fr))',
    gap: '7px',
  },
  choice: {
    fontSize: '12px',
    fontFamily: 'inherit',
    padding: '9px 8px',
    borderRadius: '10px',
    border: '1px solid ' + C.border,
    backgroundColor: C.tile,
    color: C.dim,
    cursor: 'pointer',
    textAlign: 'center',
    lineHeight: '1.3',
    transition: 'border-color .16s ease, background-color .16s ease, color .16s ease',
  },
  // ★ THE CHOSEN ONE: a blue frame and blue words, so the selection is not
  // something the reader has to infer by comparing borders.
  choiceOn: {
    borderColor: C.accent,
    color: C.accent,
    fontWeight: 600,
    backgroundColor: C.accentWash,
  },
  // ★ THE BIG VALUE. The one number worth reading at a glance, printed above
  // the tiles that chose it.
  choiceDisplay: {
    display: 'flex', alignItems: 'baseline', gap: '6px',
    fontSize: '22px', fontWeight: 600, color: C.label, lineHeight: '1.1',
    fontVariantNumeric: 'tabular-nums',
  },
  switch: { accentColor: C.brand, width: '14px', height: '14px', cursor: 'pointer' },
  // ★ THE SELF-DRAWN SLIDER.
  //
  // Three parts, all of them plain elements: the track (what is pressed and
  // focused), the rail (the line the thumb runs along) and the thumb. The
  // browser's own `<input type="range">` is a grey track with a square thumb,
  // and it does not belong on a card that is otherwise built out of the
  // host's own layers.
  //
  // ★ THE THUMB OVERHANGS THE RAIL AT THE ENDS, the way the platform's own
  // slider does: the thumb is centred on its position, so at 0% half of it
  // sits before the rail's first pixel. The rail therefore spans the whole
  // track, and the value is mapped against the track's own box — a rail that
  // was inset to hide the overhang would put the thumb's position and the
  // value it stands for seven pixels apart.
  sliderTrack: {
    position: 'relative', flex: '1 1 160px', minWidth: '120px', height: '20px',
    display: 'flex', alignItems: 'center', cursor: 'pointer',
    touchAction: 'none', userSelect: 'none', outline: 'none',
  },
  sliderRail: {
    position: 'absolute', left: '0', right: '0', top: '50%', marginTop: '-3px',
    height: '4px', borderRadius: '999px',
    backgroundColor: C.tile, border: '1px solid ' + C.border,
  },
  sliderFill: {
    position: 'absolute', left: '0', top: '50%', marginTop: '-2px',
    height: '4px', borderRadius: '999px', backgroundColor: C.accent,
  },
  sliderThumb: {
    position: 'absolute', top: '50%', marginTop: '-7px',
    width: '14px', height: '14px', borderRadius: '50%',
    backgroundColor: C.onColor, border: '1px solid ' + C.borderStrong,
    boxShadow: '0 1px 4px ' + C.borderStrong,
    pointerEvents: 'none',
  },
  // The focus ring. It is a STATE and not a pseudo-class, because the card
  // draws itself with inline styles and has no stylesheet to hang `:focus`
  // on — a hand-built control that cannot show where the keyboard is has
  // taken the keyboard away.
  sliderFocus: { boxShadow: '0 0 0 3px ' + C.accentSoft },
  // ★ THE POOL ROW: one line that says how many there are and how many are
  // picked, and a chevron that says "there is more behind this".
  poolRow: {
    display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
    padding: '10px 12px', borderRadius: '10px',
    border: '1px solid ' + C.border,
    backgroundColor: C.tile,
    font: 'inherit', color: 'inherit', textAlign: 'left',
    cursor: 'pointer',
    transition: 'border-color .18s ease, background-color .18s ease',
  },
  poolValue: { flex: 'none', fontSize: '12px', color: C.dim, whiteSpace: 'nowrap' },
  // ★ THE MULTI-SELECT DIALOG.
  //
  // A fixed overlay rather than an in-card panel: the settings page scrolls,
  // and a list of materials is longer than the space the card has.
  modal: {
    position: 'fixed', inset: '0', zIndex: 2147483000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    // ★ The scrim is deeper than a plain dim: the sheet below is a translucent
    //   layer (that is how the wallpaper shows through the panels), and a
    //   dialog sitting on top of a panel must not let the panel's text read
    //   through it.
    background: 'rgba(0,0,0,.62)', padding: '24px',
  },
  sheet: {
    width: 'min(520px,92vw)', maxHeight: '80vh', overflow: 'auto',
    borderRadius: '14px',
    backgroundColor: C.layerHigh,
    // ★ AND the sheet frosts what is behind it. Without this the card's own
    //   rows show through the dialog as readable text, which reads as a
    //   rendering fault rather than as glass.
    backdropFilter: 'blur(18px) saturate(1.15)',
    WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
    border: '1px solid ' + C.borderStrong,
    boxShadow: '0 18px 48px rgba(0,0,0,.45)',
    padding: '18px 18px 14px',
    fontFamily: 'inherit',
  },
  sheetTitle: { fontSize: '14px', fontWeight: 600, color: C.label, marginBottom: '4px' },
  sheetNote: { fontSize: '12px', lineHeight: '1.6', color: C.faint, marginBottom: '12px' },
  sheetActs: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px', flexWrap: 'wrap' },
  pickList: { display: 'flex', flexDirection: 'column', gap: '2px' },
  pickRow: {
    display: 'flex', alignItems: 'center', gap: '9px',
    padding: '7px 8px', borderRadius: '9px', minWidth: 0,
  },
  pickName: {
    flex: '1 1 60px', minWidth: 0, fontSize: '12.5px', color: C.label,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  pickMeta: { flex: 'none', fontSize: '11.5px', color: C.faint, whiteSpace: 'nowrap' },
  // ★ THE LABEL THAT CARRIES THE RADIO. The radio and the name belong to the
  // label, and the buttons belong to the ROW: a button nested inside a label
  // is an interactive element inside a control, and a click on it then
  // becomes a question about label activation instead of about the button.
  pickLabel: {
    display: 'flex', alignItems: 'center', gap: '9px',
    flex: '1 1 auto', minWidth: 0, cursor: 'pointer',
  },
  radio: {
    accentColor: C.brand, width: '14px', height: '14px',
    flex: 'none', margin: '0', cursor: 'pointer',
  },
  materialWrap: { display: 'flex', flexDirection: 'column', gap: '8px' },
  previewWrap: { paddingLeft: '4px' },
  previewVideo: { maxWidth: '320px', width: '100%', borderRadius: '8px', border: '1px solid ' + C.border },
  previewImage: { maxWidth: '320px', width: '100%', borderRadius: '8px', border: '1px solid ' + C.border },
  row: { display: 'flex', alignItems: 'center', gap: '10px' },
  name: { fontSize: '12.5px', color: C.label, flex: '0 0 auto', minWidth: '72px' },
  note: { fontSize: '12px', color: C.dim, flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' },
  badge: {
    fontSize: '11px',
    padding: '1px 8px',
    borderRadius: '999px',
    border: '1px solid ' + C.border,
    color: C.dim,
    whiteSpace: 'nowrap',
  },
  badgeWarn: { color: C.warn, borderColor: C.warn },
  empty: {
    fontSize: '12px',
    color: C.dim,
    border: '1px dashed ' + C.border,
    borderRadius: '10px',
    padding: '14px 12px',
    textAlign: 'center',
  },
  input: {
    fontSize: '12.5px',
    color: C.label,
    background: 'transparent',
    border: '1px solid ' + C.border,
    borderRadius: '7px',
    padding: '4px 8px',
    minWidth: '180px',
    flex: '1 1 auto',
  },
  button: {
    fontSize: '12px',
    fontFamily: 'inherit',
    padding: '4px 12px',
    borderRadius: '7px',
    border: '1px solid ' + C.border,
    background: 'transparent',
    color: C.label,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  buttonPrimary: {
    borderColor: C.accent,
    color: C.accent,
    fontWeight: 600,
  },
}

/**
 * A small button that NEVER shrinks.
 *
 * The rows of the material picker carry a name, two badges, a size and two
 * buttons. A button that may shrink is a button whose label wraps to two
 * lines, and the row grows instead of the name being trimmed — so the thing
 * that gives way is the name, which is the one thing the row is for.
 */
S.miniButton = Object.assign({}, S.button, { flex: 'none' })

/**
 * Read one awaited service.
 *
 * `get` first: that is the form every working plugin in this deployment uses,
 * and the property proxy is topology-sensitive. The property and the outer
 * context are fallbacks for a scope that does not expose `get`.
 *
 * @param scope - the context to read from.
 * @param name - service name.
 * @param fallback - an outer context to try last.
 * @returns the service, or undefined when it is not reachable.
 */
function serviceAt(scope, name, fallback) {
  try {
    if (scope !== null && scope !== undefined && typeof scope.get === 'function') {
      const value = scope.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch (error) {
    /* a global-store miss is the expected miss */
  }
  try {
    const value = scope === null || scope === undefined ? undefined : scope[name]
    if (value !== undefined && value !== null) return value
  } catch (error) {
    /* not exposed as a property either */
  }
  try {
    if (fallback !== null && fallback !== undefined && typeof fallback.get === 'function') {
      const value = fallback.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch (error) {
    /* unreachable */
  }
  return undefined
}

/**
 * The arbitration point, IF the injected side put one there.
 *
 * ★ IT IS NEVER CREATED HERE.
 *
 * Two arbitration points would break the invariant "only one surface is on
 * screen at a time" — and that failure is invisible to every offline
 * assertion. So: no controller ⇒ no surface, and no controller of our own.
 *
 * ★ IT IS LOOKED UP WHEN IT IS NEEDED, NOT AT MODULE LOAD. The injected row
 * may land after this module is evaluated, and the desktop shell may not
 * share one `globalThis` with the page at all (that is a property of the
 * shell, not of this code). So the lookup is repeated, and the answer may
 * be "not yet".
 *
 * @returns {object|null} the arbitration point, or null when there is none.
 */
function arbitrationPoint() {
  const found = globalThis.__DSH_APPEARANCE_CONTROLLER__
  if (found === undefined || found === null) return null
  if (typeof found.state !== 'function') return null
  if (typeof found.on !== 'function') return null
  if (typeof found.apply !== 'function') return null
  if (typeof found.release !== 'function') return null
  return found
}

/**
 * The last 'change' payload the arbitration point published.
 *
 * The payload is `{ state, changed, optionsChanged }`:
 *   - `state`            — the arbitration point's whole state;
 *   - `changed`          — the slots whose own revision moved (a surface
 *                          re-applies itself only when it is in this list);
 *   - `optionsChanged`   — the options moved (re-read the volume, and do NOT
 *                          re-apply the surface: C4-1).
 *
 * @returns {object|null} the payload, or null when nothing was published yet.
 */
let latestChange = null

/**
 * Read the last published 'change' payload.
 * @returns {object|null} the payload, or null.
 */
function lastChange() {
  return latestChange
}

/* ══════════════════════════════════════════════════════════════════════════
   THE APPEARANCE CARD — three surfaces, one library.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Read the catalog once and hand it back.
 *
 * A failed read is reported in place rather than swallowed: a panel that
 * silently shows "0 entries" when the Host is not answering is a panel that
 * cannot be diagnosed.
 *
 * @param setter - the React setter.
 * @param setError - the React setter for the error line.
 * @returns a function that performs the read.
 */
function readCatalog(setter, setError) {
  return function () {
    return fetch(CATALOG_URL, { cache: 'no-store' })
      .then(function (response) {
        return response.ok ? response.json() : null
      })
      .then(function (payload) {
        if (payload === null || payload === undefined) {
          setError('读不到素材清单（宿主路由没应答）。')
          return null
        }
        setError('')
        setter(payload)
        return payload
      })
      .catch(function () {
        setError('读不到素材清单（宿主路由没应答）。')
        return null
      })
  }
}

/**
 * Where the Host accepts a slot or an option change.
 *
 * ★ THE CLIENT WRITES THROUGH THE HOST'S OWN ROUTE, NOT THROUGH THE PROFILE
 * FILE. The route is the only writer that knows the catalog, so "the catalog
 * lists it" and "the slot accepts it" stay the same question.
 */
const SLOTS_URL = '/appearance-media/slots'

/**
 * The three surfaces, each with the options it owns.
 *
 * ★ EVERY OPTION HERE EXISTS IN THE SURFACE'S OWN IMPLEMENTATION. The card
 * offers exactly what the surface can do — a control that does nothing is
 * worse than no control at all.
 *
 * ★ EVERY OPTION CARRIES A `hint`. The card prints it as the grey second line
 * under the title, so every knob says what it does AND which way the number
 * goes — 「面板不透明度（越小越透）」 is a label; 「界面有多透明：0.3 最透，
 * 1 完全不透明」 is an instruction. A slider whose direction is unstated is a
 * slider the user guesses at.
 *
 * `kind`:
 *   'switch' — a checkbox.
 *   'slider' — a range input.
 *   'choice' — a row of buttons, one of them selected.
 */
const SURFACES = [
  {
    key: 'background',
    label: '背景',
    hint: '铺在界面后面的那段视频。',
    options: [
      // ★ THE LABELS SAY WHICH WAY IS WHICH. A slider named 「遮罩浓度」 at
      // 0.5 reads as "half faded", and that is exactly what it is — half a
      // white veil over the video, so the wallpaper turns milky. The label
      // now says what the number does instead of naming the mechanism.
      { field: 'panel', label: '面板不透明度（越小越透）', kind: 'slider', min: 0.3, max: 1, step: 0.02, hint: '界面面板有多透明：0.3 最透，1 完全不透明' },
      { field: 'surface', label: '背景蒙版（越大越白）', kind: 'slider', min: 0, max: 1, step: 0.05, hint: '蒙版压多白：0 是原图，1 是全白' },
      { field: 'muted', label: '静音', kind: 'switch', hint: '背景视频不出声' },
      { field: 'pauseWhenHidden', label: '窗口隐藏时暂停', kind: 'switch', hint: '窗口不在前台时把背景停下来' },
    ],
  },
  {
    key: 'boot',
    label: '片头',
    hint: '打开页面时先放一段，然后淡进界面。',
    options: [
      { field: 'fadeMs', label: '淡入时长', kind: 'choice', choices: [[1000, '1 秒'], [1500, '1.5 秒'], [2000, '2 秒'], [3000, '3 秒'], [4000, '4 秒']], hint: '片子放完之后，界面淡进来要多久' },
      { field: 'holdMs', label: '停留时长', kind: 'choice', choices: [[5000, '5 秒'], [10000, '10 秒'], [15000, '15 秒'], [20000, '20 秒']], hint: '片子放完后再停一会儿，才开始淡入' },
      { field: 'muted', label: '播放声音', kind: 'switch', invert: true, hint: '开＝片头有声音，关＝全程静音' },
      { field: 'enterMode', label: '进入方式', kind: 'choice', choices: [['tail', '片尾交叉溶解'], ['end', '放完再淡'], ['click', '点击才进']], hint: '片尾交叉溶解 / 放完再淡 / 点击才进' },
      { field: 'source', label: '素材来源', kind: 'choice', choices: [['media', '指定片段'], ['pool', '从素材库随机']], hint: '固定放选中的那一段，还是每次从库里随机挑' },
    ],
  },
  {
    key: 'screensaver',
    label: '屏保',
    hint: '闲置一段时间后接管整个窗口，动一下就退出。',
    options: [
      { field: 'idleMs', label: '闲置后出现', kind: 'choice', choices: [[60000, '1 分钟'], [180000, '3 分钟'], [300000, '5 分钟'], [600000, '10 分钟']], hint: '鼠标键盘都不动多久之后，屏保接管窗口' },
      { field: 'rotateMs', label: '随机切换', kind: 'choice', choices: [[0, '不轮换'], [15000, '15 秒'], [30000, '30 秒'], [60000, '1 分钟'], [300000, '5 分钟']], hint: '每隔多久换一段素材；0 是一直放同一段' },
      { field: 'volume', label: '音量', kind: 'slider', min: 0, max: 1, step: 0.05, hint: '屏保素材的声音大小' },
      { field: 'muted', label: '静音', kind: 'switch', hint: '屏保不出声' },
      { field: 'breakEffect', label: '退出时播放特效', kind: 'switch', hint: '退出屏保时播一段碎裂动画' },
      // ★ THE STYLE CHOICE ONLY EXISTS WHILE THE SWITCH IS ON. A control
      // that is on screen and does nothing is worse than no control at all.
      { field: 'breakStyle', label: '退场方式', kind: 'choice', choices: [['particles', '粒子消散'], ['fall', '重力下坠'], ['glitch', 'Glitch']], when: { field: 'breakEffect', equals: true }, hint: '碎成什么样：粒子 / 下坠 / 故障' },
      { field: 'pointerEffect', label: '鼠标划过时的特效', kind: 'switch', hint: '鼠标在屏保上移动时给点反馈' },
      { field: 'pointerStyle', label: '鼠标特效', kind: 'choice', choices: [['ripples', '水波涟漪'], ['attract', '星屑吸附']], when: { field: 'pointerEffect', equals: true }, hint: '水波涟漪 / 星屑吸附' },
      { field: 'hint', label: '显示「点击或按住任意键继续」提示', kind: 'switch', hint: '在屏保上告诉用户怎么退出' },
    ],
  },
]

/**
 * Read one option's value out of the configuration.
 *
 * @param config - the whole configuration.
 * @param surface - the surface key.
 * @param field - the option field.
 * @returns the value, or undefined when it is not there.
 */
function optionValue(config, surface, field) {
  if (config === undefined || config === null) return undefined
  const options = config.options
  if (options === undefined || options === null) return undefined
  const group = options[surface]
  if (group === undefined || group === null) return undefined
  return group[field]
}

/**
 * A checkbox.
 *
 * @param props - { label, checked, invert, onChange }.
 * @returns the control element.
 */
function SwitchControl(props) {
  const checked = props.invert === true ? props.checked !== true : props.checked === true
  return h('input', {
    type: 'checkbox',
    checked: checked,
    'aria-label': props.label,
    'data-switch': props.label,
    style: S.switch,
    onChange: function (event) {
      const next = event.target.checked
      props.onChange(props.invert === true ? !next : next)
    },
  })
}

/**
 * ★ THE CARD'S AVATAR.
 *
 * The slot's registration face publishes no icon field — only `id`, `order`
 * and `label` — so the card cannot hand a picture to the Host's own header
 * row and has to draw one itself.
 *
 * ★ IT IS DRAWN, NOT FETCHED. This package ships an `icon.svg`, but the card
 * is a browser bundle with no route of its own that serves it, so an `<img>`
 * pointing at it would be a broken-image glyph in the settings page — the one
 * place a missing file is least forgivable. So the mark is inline SVG, built
 * from the same shapes as the package's icon, and every colour in it comes
 * from a Host token.
 *
 * @returns the avatar element.
 */
function CardAvatar() {
  return h('span', { style: S.avatar, 'data-card-avatar': 'true', 'aria-hidden': 'true' },
    h('svg', {
      width: '40', height: '40', viewBox: '0 0 64 64',
      role: 'presentation', focusable: 'false', style: { display: 'block', width: '40px', height: '40px' },
    },
      h('defs', null,
        h('linearGradient', { id: 'dsham-avatar-gradient', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0', stopColor: C.accent }),
          h('stop', { offset: '1', stopColor: C.accentDeep }))),
      h('rect', { x: '2', y: '2', width: '60', height: '60', rx: '14', fill: 'url(#dsham-avatar-gradient)' }),
      h('path', { d: 'M27 21 L45 32 L27 43 Z', fill: C.onColor, fillOpacity: '0.94' }),
      h('circle', { cx: '19', cy: '45', r: '4.5', fill: C.onColor, fillOpacity: '0.5' }),
      h('rect', { x: '12', y: '16', width: '14', height: '3.5', rx: '1.75', fill: C.onColor, fillOpacity: '0.5' })))
}

/**
 * Clamp a number into a range.
 *
 * @param value - the number.
 * @param min - the lower bound.
 * @param max - the upper bound.
 * @returns the number, inside the range.
 */
function clampNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Snap a number onto a step, inside a range.
 *
 * ★ THE SNAPPED VALUE IS ROUNDED TO THREE DECIMALS. The steps are fractions
 * (0.02, 0.05) and `0.3 + 10 * 0.02` is 0.5000000000000001 in binary
 * floating point; the number the card prints and the number the host stores
 * have to be the SAME number, or the thumb sits a hair away from the value it
 * stands for and a second press of the arrow key moves it by nothing.
 *
 * @param value - the number.
 * @param min - the lower bound.
 * @param max - the upper bound.
 * @param step - the step.
 * @returns the snapped number.
 */
function snapNumber(value, min, max, step) {
  const clamped = clampNumber(value, min, max)
  if (!(step > 0)) return clamped
  const steps = Math.round((clamped - min) / step)
  const snapped = min + steps * step
  return Math.round(clampNumber(snapped, min, max) * 1000) / 1000
}

/**
 * ★ THE SELF-DRAWN SLIDER.
 *
 * Three parts: the track (what is pressed and focused), the rail (the line
 * the thumb runs along) and the thumb. The browser's own `<input type="range">`
 * is a grey track with a square thumb, and it does not belong on a card that
 * is otherwise built out of the host's own layers.
 *
 * ★ IT IS A COMPONENT, NOT A FACTORY. It holds the drag draft in state, and
 * a factory's hooks land on the CALLER's fiber — the panel's hook count would
 * then change with the number of sliders on screen, which React throws on,
 * and what a user sees then is a card that is visible and completely dead.
 *
 * ★ THE DRAG MOVES A DRAFT; THE RELEASE WRITES. A slider that writes the
 * settings document on every pointer move fights the hand that is dragging
 * it: the write sets the card's busy flag, the card re-renders, and the thumb
 * jumps under the pointer. So the thumb follows the pointer through a local
 * draft, and ONE write happens when the pointer is released.
 *
 * ★ THE DRAFT IS DROPPED WHEN THE STORED VALUE CATCHES UP. The write is a
 * round trip, and a draft that was cleared the instant the pointer was
 * released would snap the thumb back to the old value for as long as the
 * round trip takes. It is cleared when the host's value matches it — and it
 * stays if the host refused the write, which is the truth.
 *
 * ★ THE KEYBOARD WORKS WITHOUT A POINTER. Arrow keys move by one step, Home
 * and End jump to the two ends, and Page Up / Page Down move by a tenth of
 * the range — the gestures the native control answers to, so the card does
 * not become a dead end for a keyboard.
 *
 * @param props - { label, value, min, max, step, onChange }.
 * @returns the control element.
 */
function SliderControl(props) {
  const draftState = React.useState(null)
  const draft = draftState[0]
  const setDraft = draftState[1]
  const draggingState = React.useState(false)
  const dragging = draggingState[0]
  const setDragging = draggingState[1]
  const focusedState = React.useState(false)
  const focused = focusedState[0]
  const setFocused = focusedState[1]

  const min = typeof props.min === 'number' ? props.min : 0
  const max = typeof props.max === 'number' && props.max > min ? props.max : min + 1
  const step = typeof props.step === 'number' && props.step > 0 ? props.step : 0.01
  const stored = typeof props.value === 'number' ? props.value : min
  const value = draft === null ? stored : draft
  const shown = Math.round(clampNumber(value, min, max) * 100) / 100
  const ratio = max > min ? clampNumber((value - min) / (max - min), 0, 1) : 0
  // ★ THE PERCENTAGE, NOT THE FRACTION. `ratio` is 0…1 and a CSS percentage
  // wants 0…100: writing the fraction straight in puts the thumb at the very
  // left of the rail and makes the filled part 0.5% wide — a slider that
  // always looks like it is at zero.
  const percent = String(Math.round(ratio * 100000) / 1000)

  // ★ THE DRAFT IS DROPPED AS SOON AS THE HOST HOLDS THE SAME VALUE.
  React.useEffect(function () {
    if (draft === null) return
    if (Math.abs(draft - stored) < 0.000001) setDraft(null)
  }, [draft, stored])

  /**
   * The value under the pointer, snapped to the step.
   *
   * @param event - the pointer event.
   * @returns the value, or null when the event carries no position.
   */
  const valueAt = function (event) {
    if (event === null || event === undefined) return null
    const node = event.currentTarget
    if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null
    const rect = node.getBoundingClientRect()
    if (rect === null || rect === undefined || typeof rect.width !== 'number' || !(rect.width > 0)) return null
    if (typeof event.clientX !== 'number') return null
    const left = typeof rect.left === 'number' ? rect.left : 0
    const raw = (event.clientX - left) / rect.width
    return snapNumber(min + raw * (max - min), min, max, step)
  }

  const onPointerDown = function (event) {
    const next = valueAt(event)
    if (next === null) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    // ★ THE POINTER IS CAPTURED, so the moves keep arriving after the
    // pointer leaves the track. Without it a drag that wanders off the rail
    // stops dead at the edge, which reads as a control that has frozen.
    const node = event.currentTarget
    if (node !== null && node !== undefined && typeof node.setPointerCapture === 'function'
      && typeof event.pointerId === 'number') {
      try {
        node.setPointerCapture(event.pointerId)
      } catch (error) {
        /* the capture is a nicety, not a requirement */
      }
    }
    setDragging(true)
    setDraft(next)
  }

  const onPointerMove = function (event) {
    if (dragging !== true) return
    const next = valueAt(event)
    if (next === null) return
    setDraft(next)
  }

  const onPointerUp = function (event) {
    if (dragging !== true) return
    setDragging(false)
    const fromEvent = valueAt(event)
    const next = fromEvent === null ? (draft === null ? stored : draft) : fromEvent
    setDraft(next)
    if (next !== stored) props.onChange(next)
  }

  const onKeyDown = function (event) {
    if (event === null || event === undefined) return
    const key = typeof event.key === 'string' ? event.key : ''
    const page = Math.max(step, (max - min) / 10)
    let next = null
    if (key === 'ArrowRight' || key === 'ArrowUp') next = snapNumber(value + step, min, max, step)
    else if (key === 'ArrowLeft' || key === 'ArrowDown') next = snapNumber(value - step, min, max, step)
    else if (key === 'PageUp') next = snapNumber(value + page, min, max, step)
    else if (key === 'PageDown') next = snapNumber(value - page, min, max, step)
    else if (key === 'Home') next = min
    else if (key === 'End') next = max
    if (next === null) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    setDragging(false)
    setDraft(next)
    if (next !== stored) props.onChange(next)
  }

  return h('div', { style: S.sliderRow },
    h('div', {
      style: focused ? { ...S.sliderTrack, ...S.sliderFocus } : S.sliderTrack,
      role: 'slider',
      tabIndex: 0,
      'aria-label': props.label,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-valuenow': shown,
      'aria-valuetext': String(shown),
      'data-slider': props.label,
      'data-slider-value': String(shown),
      onPointerDown: onPointerDown,
      onPointerMove: onPointerMove,
      onPointerUp: onPointerUp,
      onKeyDown: onKeyDown,
      onFocus: function () { setFocused(true) },
      onBlur: function () { setFocused(false) },
    },
      h('div', { style: S.sliderRail, 'data-slider-rail': 'true' },
        h('div', { style: { ...S.sliderFill, width: percent + '%' }, 'data-slider-fill': 'true' }),
        h('div', { style: { ...S.sliderThumb, left: percent + '%' }, 'data-slider-thumb': 'true' }))),
    h('span', { style: S.value, 'data-slider-number': props.label }, String(shown)))
}

/**
 * A row of button cards, one of them selected.
 *
 * ★ THE SELECTED BUTTON IS MARKED WITH `aria-pressed`, so a browser check can
 * tell which one is on without reading the styling.
 *
 * ★ THE BIG VALUE ABOVE THE TILES. A choice of numbers is a duration, and a
 * duration is the one thing in this card that is worth reading at a glance —
 * so the chosen one is printed at display size and the tiles below it are the
 * way to change it. A choice of words (进入方式) prints no big value: the
 * chosen word IS the label of the tile, so printing it twice would be noise.
 *
 * @param props - { label, value, choices, onChange }.
 * @returns the control element.
 */
function ChoiceControl(props) {
  const value = props.value
  const buttons = props.choices.map(function (choice) {
    const selected = choice[0] === value
    return h('button', {
      type: 'button',
      key: String(choice[0]),
      'aria-pressed': selected ? 'true' : 'false',
      'data-choice': props.label + '=' + String(choice[0]),
      style: selected ? { ...S.choice, ...S.choiceOn } : S.choice,
      onClick: function () { props.onChange(choice[0]) },
    }, choice[1])
  })
  const numeric = props.choices.every(function (choice) { return typeof choice[0] === 'number' })
  const chosen = props.choices.filter(function (choice) { return choice[0] === value })[0]
  const big = numeric && chosen !== undefined ? String(chosen[1]) : null
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    big === null
      ? null
      : h('div', { style: S.choiceDisplay, 'data-choice-display': props.label }, big),
    h('div', { style: S.choices }, buttons))
}

/**
 * ★ ONE ITEM: ITS OWN CARD, THE TITLE, THE GREY LINE UNDER IT, THE CONTROL.
 *
 * Two lines for the text, and the control beside or below it. A switch sits
 * on the title's right — a checkbox under its own title reads as a form
 * nobody filled in — while a slider or a row of buttons sits under the two
 * lines, because it needs the width.
 *
 * ★ THE PLATE AROUND IT. Every option is a rounded card of its own. The
 * options used to share one sheet with nothing between them, and a stack of
 * controls with no separation is a wall: the reader cannot tell where one
 * knob ends and the next begins.
 *
 * @param props - { spec, value, onChange }.
 * @returns the item element.
 */
function OptionItem(props) {
  const spec = props.spec
  const text = h('div', { style: S.itemText },
    h('span', { style: S.itemTitle, 'data-option-title': spec.field }, spec.label),
    h('span', { style: S.itemHint, 'data-option-hint': spec.field }, spec.hint === undefined || spec.hint === null ? '' : spec.hint))
  if (spec.kind === 'switch') {
    return h('div', { style: S.optionCard, 'data-option': spec.field, 'data-option-card': 'true' },
      h('div', { style: S.itemHead },
        text,
        h('div', { style: S.itemAside },
          SwitchControl({
            label: spec.label,
            checked: props.value,
            invert: spec.invert === true,
            onChange: props.onChange,
          }))))
  }
  let control = null
  if (spec.kind === 'slider') {
    // ★ THE SLIDER IS RENDERED AS AN ELEMENT, NOT CALLED. It holds state, and
    // a component that is called instead of rendered keeps its hooks on the
    // CALLER's fiber — the panel's hook count would then change with the
    // number of sliders on screen, which React throws on.
    control = h(SliderControl, {
      label: spec.label,
      value: props.value,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      onChange: props.onChange,
    })
  } else {
    control = ChoiceControl({
      label: spec.label,
      value: props.value,
      choices: spec.choices,
      onChange: props.onChange,
    })
  }
  return h('div', { style: S.optionCard, 'data-option': spec.field, 'data-option-card': 'true' },
    text,
    h('div', { style: S.itemControl }, control))
}

/**
 * ★ THE MATERIAL SUMMARY ROW: ONE LINE, AND A CHEVRON.
 *
 * It reads 「素材　当前：p05-bg-2.mp4 ›」 — which material the surface is
 * playing right now — and it is the ONLY thing the card says about materials
 * until the reader opens it.
 *
 * ★ THE LIST USED TO BE PRINTED UNDER EVERY SURFACE. Three surfaces and
 * fourteen materials each: forty-two rows of a card nobody could reach the
 * bottom of, with the same fourteen names three times. The one line says the
 * same fact in one place, and the picker says the rest on request.
 *
 * ★ A MATERIAL THAT WAS DELETED IS STILL NAMED. The surface can point at a
 * material the library no longer holds; the row then says so instead of
 * pretending the surface has no material at all.
 *
 * @param props - { surface, surfaceLabel, mediaId, entry, missing, onOpen }.
 * @returns the row element.
 */
function MediaSummaryRow(props) {
  const entry = props.entry
  const missing = props.missing === true
  const name = entry !== undefined && entry !== null
    ? entry.name
    : (missing ? props.mediaId : '未选择')
  return h('button', {
    type: 'button',
    style: S.poolRow,
    'data-media-row': props.surface,
    'aria-haspopup': 'dialog',
    'aria-label': '选择「' + props.surfaceLabel + '」的素材',
    onClick: props.onOpen,
  },
    h('span', { style: S.itemText },
      h('span', { style: S.itemTitle }, '素材'),
      h('span', { style: S.itemHint }, '从素材库里挑一条')),
    h('span', { style: S.poolValue, 'data-media-current': props.surface },
      '当前：' + name + (missing ? '（已丢失）' : '') + ' ›'))
}

/**
 * ★ THE DELETE REQUEST.
 *
 * One call, one shape, two callers: the material picker in the card and the
 * library on the bundle's own page. Both have to behave the same way, so the
 * request and the reading of the answer live here.
 *
 * ★ THE HOST'S SENTENCE IS PASSED THROUGH AS IT IS. The Host refuses a
 *   traversal, refuses an unknown id and refuses a directory it cannot write
 *   to, and each of those refusals says something the user can act on. A card
 *   that rewrote it into its own words would throw that away.
 *
 * @param id - the material's id.
 * @returns a promise for `{ ok, body, status, offline }`.
 */
function deleteMaterialRequest(id) {
  return fetch(MEDIA_DELETE_URL + encodeURIComponent(id), { method: 'DELETE' })
    .then(function (response) {
      return response.json().then(function (body) {
        return {
          ok: response.ok === true && body !== null && body !== undefined && body.ok === true,
          body: body,
          status: response.status,
          offline: false,
        }
      }).catch(function () {
        return { ok: false, body: null, status: response.status, offline: false }
      })
    })
    .catch(function () {
      return { ok: false, body: null, status: 0, offline: true }
    })
}

/**
 * ★ THE DELETE CONFIRMATION.
 *
 * A material is the user's own file, and there is no undo. So the delete is
 * never one click: the button opens this sheet, the sheet says WHICH material
 * and what else moves with it, and only 确定 sends the request. 取消 closes the
 * sheet and NOTHING HAPPENS — no request, no change.
 *
 * ★ IT IS A PLAIN FACTORY, NOT A COMPONENT — like the two pickers, it calls no
 * hooks, so the panel's hook count does not change when the sheet opens.
 *
 * @param props - { message, error, busy, onConfirm, onCancel }.
 * @returns the sheet element.
 */
function DeleteConfirmDialog(props) {
  return h('div', {
    style: S.modal,
    'data-media-delete-confirm': 'true',
    // ★ THE CLICK DOES NOT REACH THE PICKER BEHIND IT. Otherwise cancelling a
    // delete would also close the material picker, and the user would lose
    // the draft they were picking.
    onClick: function (event) {
      event.stopPropagation()
      props.onCancel()
    },
  },
    h('div', {
      style: S.sheet,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '确认删除素材',
      onClick: function (event) { event.stopPropagation() },
    },
      h('div', { style: S.sheetTitle }, '删掉这条素材？'),
      h('div', { style: S.sheetNote }, props.message),
      props.error === '' || props.error === null || props.error === undefined
        ? null
        : h('div', {
          style: { ...S.note, color: C.error },
          role: 'alert',
          'data-media-delete-error': 'true',
        }, props.error),
      h('div', { style: S.sheetActs },
        h('button', {
          type: 'button',
          style: S.button,
          'data-media-delete-cancel': 'true',
          onClick: props.onCancel,
        }, '取消'),
        h('button', {
          type: 'button',
          style: { ...S.button, ...S.buttonPrimary },
          'data-media-delete-ok': 'true',
          disabled: props.busy === true,
          onClick: props.onConfirm,
        }, props.busy === true ? '删除中…' : '删除'))))
}

/**
 * ★ THE SINGLE-SELECT MATERIAL DIALOG.
 *
 * The same shell as the pool picker: a fixed overlay, a `role="dialog"` sheet
 * with `aria-modal`, a click on the backdrop closes it, and 确定 / 取消 at the
 * bottom. One radio per material, and the one the surface is using carries a
 * 「当前」 badge.
 *
 * ★ A PLAIN FACTORY, NOT A COMPONENT — like the pool picker, it calls no
 * hooks, so the panel's hook count does not change when the dialog opens.
 *
 * ★ THE MATERIAL THAT WAS DELETED STILL GETS A ROW. The surface can point at
 * a material the library no longer holds; the dialog must not lose the
 * selection and must not throw while showing it. Such a row is marked 已丢失.
 *
 * ★ THE PREVIEW IS INLINE, right under its own row, exactly as it was in the
 * flat list: the material plays in place, so the reader sees what it looks
 * like without the real surface taking the screen.
 *
 * @param props - { entries, surface, surfaceLabel, draft, currentId, previewing,
 *                  status, deleteRequest, deleteBusy, deleteStatus, onPick,
 *                  onPreview, onOptimize, onDeleteRequest, onDeleteConfirm,
 *                  onDeleteCancel, onConfirm, onCancel }.
 * @returns the dialog element.
 */
function MediaPickerDialog(props) {
  const entries = props.entries
  const draft = props.draft
  const currentId = props.currentId
  // ★ A NULL-PROTOTYPE MAP. A material whose id is `constructor` or
  // `__proto__` must not be found on the prototype chain — that would hide a
  // deleted material from the 「已丢失」 row.
  const known = Object.create(null)
  for (const entry of entries) known[entry.id] = true
  const rows = []
  for (const entry of entries) {
    const isCurrent = entry.id === currentId
    const isPreviewing = props.previewing === entry.id
    const isOptimizing = props.status !== null && props.status !== undefined
      && props.status.id === entry.id && props.status.state === 'busy'
    const isDeleting = props.deleteBusy === true
      && props.deleteRequest !== null && props.deleteRequest !== undefined
      && props.deleteRequest.id === entry.id
    rows.push(h('div', {
      key: 'e-' + entry.id,
      style: S.materialWrap,
      'data-media-id': entry.id,
    },
      h('div', { style: S.pickRow },
        h('label', { style: S.pickLabel },
          h('input', {
            type: 'radio',
            name: 'dsham-media-' + props.surface,
            checked: draft === entry.id,
            style: S.radio,
            'data-media-radio': entry.id,
            onChange: function () { props.onPick(entry.id) },
          }),
          h('span', { style: S.pickName, title: entry.name }, entry.name)),
        h('span', { style: S.badge }, entry.kind === 'image' ? '图片' : '视频'),
        isCurrent
          ? h('span', { style: S.badge, 'data-media-current-badge': entry.id }, '当前')
          : null,
        h('span', { style: S.pickMeta }, formatBytes(entry.bytes)),
        h('button', {
          type: 'button',
          style: S.miniButton,
          'data-media-optimize': entry.id,
          title: '让浏览器不用下完整个文件就能出第一帧。体积会变，就地改写。',
          onClick: function () { props.onOptimize(entry.id) },
        }, isOptimizing ? '优化中…' : '优化'),
        // ★ THE DELETE. It never deletes on the first click: it opens the
        // confirmation sheet, and only 确定 sends the request.
        h('button', {
          type: 'button',
          style: { ...S.miniButton, borderColor: C.warn, color: C.warn },
          'data-media-delete': entry.id,
          title: '删掉这条素材。删了就找不回来了。',
          onClick: function () { props.onDeleteRequest(entry.id) },
        }, isDeleting ? '删除中…' : '删除'),
        h('button', {
          type: 'button',
          style: S.miniButton,
          'data-media-preview': entry.id,
          onClick: function () { props.onPreview(entry.id) },
        }, isPreviewing ? '停止' : '预览')),
      isPreviewing
        ? h('div', { style: S.previewWrap },
          entry.kind === 'image'
            ? h('img', { src: entry.mediaUrl, alt: entry.name, style: S.previewImage })
            : h('video', {
              src: entry.mediaUrl,
              controls: true,
              autoPlay: true,
              loop: true,
              muted: true,
              style: S.previewVideo,
            }))
        : null))
  }
  // ★ THE DELETED MATERIAL, MARKED.
  if (currentId !== null && currentId !== undefined && currentId !== '' && known[currentId] !== true) {
    rows.push(h('div', {
      key: 'm-' + currentId,
      style: S.pickRow,
      'data-media-missing': currentId,
    },
      h('span', { style: S.pickName, title: currentId }, currentId),
      h('span', { style: { ...S.badge, ...S.badgeWarn } }, '已丢失'),
      h('span', { style: S.badge, 'data-media-current-badge': currentId }, '当前')))
  }
  const status = props.status
  const statusStyle = status === null || status === undefined
    ? null
    : status.state === 'error'
      ? { ...S.note, color: C.error }
      : status.state === 'busy'
        ? S.note
        : { ...S.note, color: C.ok }
  return h('div', {
    style: S.modal,
    'data-media-dialog': 'true',
    onClick: props.onCancel,
  },
    h('div', {
      style: S.sheet,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '选择素材',
      onClick: function (event) { event.stopPropagation() },
    },
      h('div', { style: S.sheetTitle }, '选择「' + props.surfaceLabel + '」的素材'),
      h('div', { style: S.sheetNote },
        '选一条存下来。带「当前」标记的那条，是这个表面现在正在用的。'),
      h('div', { style: S.pickList },
        rows.length === 0 ? h('div', { style: S.empty }, '素材库是空的。') : rows),
      status === null || status === undefined
        ? null
        : h('div', {
          style: statusStyle,
          role: 'status',
          'data-optimize-status': status.state,
        }, status.text),
      // ★ WHAT THE LAST DELETE SAID. It stays until the picker closes, so the
      // user can read 「已删除「清晨」」 after the row is already gone.
      props.deleteStatus === null || props.deleteStatus === undefined
        ? null
        : h('div', {
          style: props.deleteStatus.state === 'error'
            ? { ...S.note, color: C.error }
            : { ...S.note, color: C.ok },
          role: 'status',
          'data-media-delete-status': props.deleteStatus.state,
        }, props.deleteStatus.text),
      h('div', { style: S.sheetActs },
        h('button', {
          type: 'button',
          style: S.button,
          'data-media-cancel': 'true',
          onClick: props.onCancel,
        }, '取消'),
        h('button', {
          type: 'button',
          style: { ...S.button, ...S.buttonPrimary },
          'data-media-apply': 'true',
          onClick: props.onConfirm,
        }, '确定'))),
    // ★ THE CONFIRMATION SHEET, ON TOP OF THE PICKER. It is a SIBLING of the
    // sheet and not a child of it, so it covers the whole screen — and its
    // own click stops there, so cancelling a delete does not close the
    // picker behind it.
    props.deleteRequest === null || props.deleteRequest === undefined
      ? null
      : DeleteConfirmDialog({
        message: props.deleteRequest.message,
        error: props.deleteRequest.error === undefined ? '' : props.deleteRequest.error,
        busy: props.deleteBusy === true,
        onConfirm: props.onDeleteConfirm,
        onCancel: props.onDeleteCancel,
      }))
}

/**
 * The ids the boot pool currently holds.
 *
 * ★ A VALUE THAT IS NOT A LIST IS NOT A LIST. The configuration is read from
 * a file a person can edit, so `pool` may be a string, a number, or missing.
 * Every one of those means "no narrowing" — the whole library — and the card
 * has to say that rather than throw on `.indexOf`.
 *
 * @param config - the whole configuration.
 * @returns the ids, as a list of strings.
 */
function poolIds(config) {
  const raw = optionValue(config, 'boot', 'pool')
  if (!Array.isArray(raw)) return []
  return raw.filter(function (id) { return typeof id === 'string' && id !== '' })
}

/**
 * The name of one surface, as the card spells it.
 *
 * @param key - the surface key.
 * @returns the label, or an empty string when the key is not one of them.
 */
function mediaSurfaceLabel(key) {
  const found = SURFACES.filter(function (surface) { return surface.key === key })[0]
  return found === undefined ? '' : found.label
}

/**
 * The material one surface is playing right now.
 *
 * @param config - the whole configuration.
 * @param key - the surface key.
 * @returns the id, or null when the surface has none.
 */
function mediaSurfaceId(config, key) {
  if (config === null || config === undefined || config.slots === undefined) return null
  const slots = config.slots
  const slot = slots[key] !== undefined ? slots[key] : {}
  return typeof slot.mediaId === 'string' && slot.mediaId !== '' ? slot.mediaId : null
}

/**
 * The label of one choice, as the surface itself spells it.
 *
 * @param surface - the surface's spec.
 * @param field - the option field.
 * @param value - the stored value.
 * @returns the label, or an empty string when the value is not one of them.
 */
function choiceLabel(surface, field, value) {
  const specs = surface.options.filter(function (spec) { return spec.field === field })
  const spec = specs[0]
  if (spec === undefined || !Array.isArray(spec.choices)) return ''
  const found = spec.choices.filter(function (choice) { return choice[0] === value })[0]
  return found === undefined ? '' : String(found[1])
}

/**
 * ★ ONE LINE THAT SAYS WHAT THE SURFACE IS DOING RIGHT NOW.
 *
 * This is the summary on the collapsed group, so it has to carry the state a
 * reader wants BEFORE opening anything: is it on, and what is it doing.
 *
 * @param surface - the surface's spec.
 * @param config - the whole configuration.
 * @param entries - the catalog entries.
 * @returns the one-line summary.
 */
function surfaceSummary(surface, config, entries) {
  const slots = config !== null && config !== undefined && config.slots !== undefined ? config.slots : {}
  const slot = slots[surface.key] !== undefined ? slots[surface.key] : {}
  if (slot.enabled !== true) return '已关闭'
  if (surface.key === 'background') {
    const mediaId = typeof slot.mediaId === 'string' ? slot.mediaId : null
    const entry = entries.filter(function (e) { return e.id === mediaId })[0]
    return '已开启 · 当前：' + (entry !== undefined ? entry.name : '未选择')
  }
  if (surface.key === 'boot') {
    const mode = choiceLabel(surface, 'enterMode', optionValue(config, 'boot', 'enterMode'))
    return '已开启' + (mode === '' ? '' : ' · 进入方式：' + mode)
  }
  const idle = choiceLabel(surface, 'idleMs', optionValue(config, 'screensaver', 'idleMs'))
  return '已开启' + (idle === '' ? '' : '，闲置 ' + idle + '后出现')
}

/**
 * ★ THE POOL ROW: ONE LINE, AND A CHEVRON THAT SAYS "THERE IS MORE".
 *
 * It reads 「5 段，已选 3 ›」 — how many materials the library holds and how
 * many of them the pool is narrowed down to. Clicking it opens the picker.
 *
 * @param props - { total, selected, onOpen }.
 * @returns the row element.
 */
function PoolRow(props) {
  return h('button', {
    type: 'button',
    style: S.poolRow,
    'data-pool-open': 'true',
    'aria-haspopup': 'dialog',
    onClick: props.onOpen,
  },
    h('span', { style: S.itemText },
      h('span', { style: S.itemTitle }, '片头素材池'),
      h('span', { style: S.itemHint }, '不选 = 整个素材库随机；勾选后只从选中的素材里挑')),
    h('span', { style: S.poolValue, 'data-pool-count': 'true' },
      String(props.total) + ' 段，已选 ' + String(props.selected) + ' ›'))
}

/**
 * ★ THE MULTI-SELECT DIALOG.
 *
 * A plain factory rather than a component, and that is deliberate: it calls
 * no hooks, so the panel's hook count does not change when the dialog opens
 * or closes. A component with hooks would make React change the number of
 * hooks under a live card, which throws and leaves a card that is visible
 * and dead.
 *
 * ★ A SELECTED MATERIAL THAT IS NOT IN THE LIBRARY STILL GETS A ROW. The
 * material was deleted after it was picked; the panel must not lose the
 * selection, and it must not throw while showing it. Such a row is marked
 * 已丢失, so the user can see it and un-tick it.
 *
 * @param props - { entries, draft, onToggle, onAll, onNone, onConfirm, onClose }.
 * @returns the dialog element.
 */
function PoolDialog(props) {
  const entries = props.entries
  const draft = props.draft
  // ★ A NULL-PROTOTYPE MAP. A material whose id is `constructor` or
  // `__proto__` must not be found on the prototype chain — that would hide a
  // deleted material from the 「已丢失」 row.
  const known = Object.create(null)
  for (const entry of entries) known[entry.id] = true
  const missing = draft.filter(function (id) { return known[id] !== true })
  const rows = []
  for (const entry of entries) {
    rows.push(h('label', { key: 'e-' + entry.id, style: S.pickRow },
      h('input', {
        type: 'checkbox',
        checked: draft.indexOf(entry.id) !== -1,
        'data-pool-check': entry.id,
        onChange: function () { props.onToggle(entry.id) },
      }),
      h('span', { style: S.pickName, title: entry.name }, entry.name),
      h('span', { style: S.badge }, entry.kind === 'image' ? '图片' : '视频'),
      h('span', { style: S.pickMeta }, formatBytes(entry.bytes))))
  }
  for (const id of missing) {
    rows.push(h('label', { key: 'm-' + id, style: S.pickRow },
      h('input', {
        type: 'checkbox',
        checked: true,
        'data-pool-check': id,
        'data-pool-missing': id,
        onChange: function () { props.onToggle(id) },
      }),
      h('span', { style: S.pickName, title: id }, id),
      h('span', { style: { ...S.badge, ...S.badgeWarn } }, '已丢失')))
  }
  return h('div', {
    style: S.modal,
    'data-pool-dialog': 'true',
    onClick: props.onClose,
  },
    h('div', {
      style: S.sheet,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '片头素材池',
      onClick: function (event) { event.stopPropagation() },
    },
      h('div', { style: S.sheetTitle }, '片头素材池'),
      h('div', { style: S.sheetNote }, '不选 = 整个素材库随机。勾选后，片头只从选中的素材里挑。'),
      h('div', { style: S.pickList },
        rows.length === 0 ? h('div', { style: S.empty }, '素材库是空的。') : rows),
      h('div', { style: S.sheetActs },
        h('button', { type: 'button', style: S.button, 'data-pool-all': 'true', onClick: props.onAll }, '全选'),
        h('button', { type: 'button', style: S.button, 'data-pool-none': 'true', onClick: props.onNone }, '清空'),
        h('button', { type: 'button', style: S.button, 'data-pool-cancel': 'true', onClick: props.onClose }, '取消'),
        h('button', {
          type: 'button',
          style: { ...S.button, ...S.buttonPrimary },
          'data-pool-apply': 'true',
          onClick: props.onConfirm,
        }, '确定'))))
}

/**
 * ★ ONE SURFACE: A FOLDING CARD WITH A SUMMARY LINE AND A SWITCH.
 *
 * The head is one row — chevron, name, one line of state, switch — and the
 * body is mounted only while the card is open. The summary is what makes the
 * closed card worth reading: a section whose closed state says only "更多"
 * makes every visit an opening.
 *
 * @param props - { surface, config, entries, busy, open, onExpand,
 *                  onToggle, onOption, onOpenPool, onOpenMedia }.
 * @returns the group element.
 */
function SurfaceGroup(props) {
  const surface = props.surface
  const config = props.config
  const slots = config !== null && config !== undefined && config.slots !== undefined ? config.slots : {}
  const slot = slots[surface.key] !== undefined ? slots[surface.key] : {}
  const enabled = slot.enabled === true
  const mediaId = typeof slot.mediaId === 'string' ? slot.mediaId : null
  const open = props.open === true
  // ★ A CONTROL WITH A CONDITION IS ONLY DRAWN WHEN THE CONDITION HOLDS.
  //
  // `when: { field, equals }` reads the CURRENT value of another option in
  // the same group, so the style pickers follow their master switches.
  const controls = surface.options.filter(function (spec) {
    if (spec.when === undefined || spec.when === null) return true
    return optionValue(config, surface.key, spec.when.field) === spec.when.equals
  }).map(function (spec) {
    return OptionItem({
      spec: spec,
      value: optionValue(config, surface.key, spec.field),
      onChange: function (value) { props.onOption(surface.key, spec.field, value) },
    })
  })
  // ★ THE MATERIAL SUMMARY, NOT THE MATERIAL LIST. One line per surface:
  // which material it is playing, and a chevron that says the rest is behind
  // a click.
  const mediaEntry = props.entries.filter(function (e) { return e.id === mediaId })[0]
  const mediaMissing = mediaId !== null && mediaId !== '' && mediaEntry === undefined
  const summary = surfaceSummary(surface, config, props.entries)
  return h('div', {
    style: open ? { ...S.group, ...S.groupOpen } : S.group,
    'data-surface': surface.key,
    'data-open': open ? '1' : '0',
    // ★ THE MARKER FOR THE RAIL. The rail itself is a background image on
    // this element (a child would poke out of the rounded corner), so the
    // marker is what lets a check — and a reader of the DOM — find it.
    'data-accent-bar': 'true',
  },
    h('div', { style: S.groupHead },
      h('button', {
        type: 'button',
        style: S.groupHeadButton,
        'aria-expanded': open,
        'data-group-toggle': surface.key,
        onClick: function () { props.onExpand(surface.key) },
      },
        h('span', {
          style: open ? { ...S.groupChev, ...S.groupChevOpen } : S.groupChev,
          'aria-hidden': 'true',
        }),
        h('span', { style: S.groupTitle }, surface.label),
        h('span', { style: S.groupSummary, 'data-group-summary': surface.key }, summary)),
      h('div', { style: S.itemAside },
        SwitchControl({
          label: '启用' + surface.label,
          checked: enabled,
          onChange: function (next) { props.onToggle(surface.key, next) },
        }))),
    open
      ? h('div', { style: S.groupBody, 'data-group-body': surface.key },
        h('div', { style: S.itemStack }, controls),
        surface.key === 'boot'
          ? PoolRow({
            total: props.entries.length,
            selected: poolIds(config).length,
            onOpen: props.onOpenPool,
          })
          : null,
        MediaSummaryRow({
          surface: surface.key,
          surfaceLabel: surface.label,
          mediaId: mediaId,
          entry: mediaEntry,
          missing: mediaMissing,
          onOpen: function () { props.onOpenMedia(surface.key) },
        }))
      : null)
}

/**
 * The overview strip: one row, three surfaces, each REPORTING its state.
 *
 * ★ NO CHECKBOX HERE. The pill used to carry one, and it said exactly what
 * the switch on the surface's own row says — two controls for one fact, and
 * the reader has to guess which of them is the real one. The switch on the
 * group's row is the master (it is what turns the surface on), so the pill
 * only reports: the surface's name, the material it is showing, and a dot
 * that says on or off.
 *
 * @param props - the surfaces, the config, the entries.
 * @returns the element.
 */
function SurfaceOverview(props) {
  const slots = props.config !== null && props.config !== undefined && props.config.slots !== undefined ? props.config.slots : {}
  const items = props.surfaces.map(function (surface) {
    const slot = slots[surface.key] !== undefined ? slots[surface.key] : {}
    const enabled = slot.enabled === true
    const mediaId = typeof slot.mediaId === 'string' ? slot.mediaId : null
    const entry = props.entries.filter(function (e) { return e.id === mediaId })[0]
    const name = entry !== undefined ? entry.name : '（未选择）'
    return h('div', {
      style: enabled ? S.overviewItemOn : S.overviewItem,
      'data-overview': surface.key,
    },
      h('span', {
        style: enabled ? { ...S.dot, ...S.dotOn } : { ...S.dot, ...S.dotOff },
        'data-overview-dot': surface.key,
        'data-on': enabled ? '1' : '0',
        'aria-hidden': 'true',
      }),
      h('div', { style: { minWidth: 0 } },
        h('div', { style: S.overviewName }, surface.label),
        h('div', { style: S.overviewMeta, title: name }, name)))
  })
  return h('div', { style: S.overview }, items)
}

/**
 * The Plugins page's card body.
 *
 * ★ THE PAGE ASKS FOR TWO DIFFERENT THINGS THROUGH ONE ENTRY: a one-liner
 * for the collapsed row (`view: "summary"`) and the configuration section for
 * the opened card (`view: "page"`). The two shapes use a different number of
 * hooks, so they are two components and this dispatcher picks between them.
 *
 * @param props - the slot's props, including the injected renderer.
 * @returns the element.
 */
function AppearanceEntry(props) {
  const renderer = props.runtime
  if (renderer !== undefined && renderer !== null && typeof renderer.createElement === 'function') {
    return renderer.createElement(props.view === 'summary' ? AppearanceSummary : AppearancePanel, props)
  }
  // No renderer on the inject face: fall back to calling them directly.
  return props.view === 'summary' ? AppearanceSummary() : AppearancePanel()
}

/**
 * The collapsed row's one-liner.
 *
 * ★ IT IS A STRING, NOT A COMPONENT WITH HOOKS. The Plugins page renders this
 * shape for the collapsed row and the other shape for the opened card, and it
 * switches between them on the SAME entry — so a summary that called hooks
 * would share a fiber with the card and change its hook count under React,
 * which throws and leaves a card that is visible and dead. The description is
 * a constant, so it cannot have that problem.
 *
 * @returns the one-line description.
 */
function AppearanceSummary() {
  return '背景、片头与屏保的素材与选项'
}

/**
 * The settings page's panel: the three surfaces and the material library.
 *
 * ★ ONE CARD, THREE GROUPS. The user configures the background, the boot
 * clip and the screensaver in one place, and picks the material of each one
 * from the same library. That is the whole point of the plugin: one entry,
 * one library, one card.
 *
 * @returns the panel element.
 */
function AppearancePanel() {
  const catalogState = React.useState(null)
  const catalog = catalogState[0]
  const setCatalog = catalogState[1]
  const configState = React.useState(null)
  const config = configState[0]
  const setConfig = configState[1]
  const errorState = React.useState('')
  const error = errorState[0]
  const setError = errorState[1]
  const busyState = React.useState(false)
  const busy = busyState[0]
  const setBusy = busyState[1]
  const previewState = React.useState(null)
  const previewId = previewState[0]
  const setPreviewId = previewState[1]
  // ★ WHICH GROUPS ARE OPEN. Disclosure is card-local state: the surface
  // cards fold, and the ones the user actually touches start open. Every
  // group carries its own summary line, so a closed one still says what it
  // is doing.
  const groupsState = React.useState({ background: true, boot: true, screensaver: false })
  const groups = groupsState[0]
  const setGroups = groupsState[1]
  // ★ WHETHER THE CARD ITSELF IS FOLDED. The head carries a chevron, and a
  // chevron that folds nothing is a lie told to the eye — so the head folds
  // the card.
  //
  // It starts OPEN, because this card IS the page: a page that arrives
  // folded shows the reader a title and nothing else.
  const cardOpenState = React.useState(true)
  const cardOpen = cardOpenState[0]
  const setCardOpen = cardOpenState[1]
  // The pool picker: whether it is open, and the selection being edited in
  // it. The draft is SEPARATE from the stored value — the store only moves
  // when the user presses 确定, so a stray click in the list cannot narrow
  // the pool behind the user's back.
  const poolOpenState = React.useState(false)
  const poolOpen = poolOpenState[0]
  const setPoolOpen = poolOpenState[1]
  const draftState = React.useState([])
  const draft = draftState[0]
  const setDraft = draftState[1]
  // ★ THE MATERIAL PICKER: which surface is being configured, the id being
  // edited in it, and what the last optimize call said.
  //
  // The draft is SEPARATE from the stored value — the store only moves when
  // the user presses 确定, so a stray click in the list cannot change the
  // surface behind the user's back.
  const mediaOpenState = React.useState(false)
  const mediaOpen = mediaOpenState[0]
  const setMediaOpen = mediaOpenState[1]
  const mediaSurfaceState = React.useState(null)
  const mediaSurface = mediaSurfaceState[0]
  const setMediaSurface = mediaSurfaceState[1]
  const mediaDraftState = React.useState(null)
  const mediaDraft = mediaDraftState[0]
  const setMediaDraft = mediaDraftState[1]
  // The last optimize call: `{ id, state, text }`, where the state is one of
  // 'busy' / 'done' / 'already' / 'error'.
  const optimizeState = React.useState(null)
  const optimize = optimizeState[0]
  const setOptimize = optimizeState[1]
  // ★ THE DELETE. Which material the user asked to delete, whether the request
  // is in flight, and what the last delete said.
  //
  // The delete is a TWO-STEP thing: the row's button only ASKS, and the
  // confirmation sheet is what sends the request. Keeping the request in the
  // panel — and not in the row — is what makes "取消 does nothing" true.
  const deleteState = React.useState(null)
  const deleteRequest = deleteState[0]
  const setDeleteRequest = deleteState[1]
  const deleteBusyState = React.useState(false)
  const deleteBusy = deleteBusyState[0]
  const setDeleteBusy = deleteBusyState[1]
  const deleteStatusState = React.useState(null)
  const deleteStatus = deleteStatusState[0]
  const setDeleteStatus = deleteStatusState[1]

  React.useEffect(function () {
    let alive = true
    const read = readCatalog(
      function (payload) { if (alive) setCatalog(payload) },
      function (message) { if (alive) setError(message) },
    )
    read()
    fetch(SLOTS_URL, { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null })
      .then(function (payload) {
        if (!alive) return
        if (payload === null || payload === undefined || payload.config === undefined) {
          setError('读不到槽位配置（宿主路由没应答）。')
          return
        }
        setConfig(payload.config)
      })
      .catch(function () { if (alive) setError('读不到槽位配置（宿主路由没应答）。') })
    return function () { alive = false }
  }, [])

  const entries = catalog !== null && Array.isArray(catalog.entries) ? catalog.entries : []

  const write = function (patch) {
    setBusy(true)
    return fetch(SLOTS_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then(function (response) { return response.json() })
      .then(function (payload) {
        setBusy(false)
        if (payload === null || payload === undefined || payload.ok !== true) {
          setError(payload !== null && payload !== undefined ? String(payload.error) : '写入失败。')
          return
        }
        setConfig(payload.config)
        const ignored = Array.isArray(payload.ignored) ? payload.ignored : []
        setError(ignored.length === 0 ? '' : '宿主还不认识这些字段，等宿主重启后生效：' + ignored.join('、'))
      })
      .catch(function () {
        setBusy(false)
        setError('写入失败（宿主路由没应答）。')
      })
  }

  const toggle = function (key, enabled) {
    write({ slot: key, enabled: enabled })
  }

  const select = function (key, mediaId) {
    write({ slot: key, mediaId: mediaId })
  }

  const setOption = function (group, field, value) {
    const patch = { options: {} }
    patch.options[group] = {}
    patch.options[group][field] = value
    write(patch)
  }

  const togglePreview = function (id) {
    setPreviewId(previewId === id ? null : id)
  }

  // ★ FOLDING A GROUP. The state is the whole map, replaced with a copy —
  // mutating the map in place would leave React with the same reference and
  // no reason to re-render, and the card would not move.
  const expand = function (key) {
    setGroups(Object.assign({}, groups, { [key]: !(groups[key] === true) }))
  }

  // ★ OPENING THE POOL PICKER.
  //
  // The list comes from the catalog route, so it is re-read on every open: a
  // material imported since the panel loaded must be in the list the user is
  // looking at. The draft starts from what is STORED, so cancelling really
  // cancels.
  const openPool = function () {
    setDraft(poolIds(config))
    setPoolOpen(true)
    readCatalog(setCatalog, setError)()
  }

  const closePool = function () {
    setPoolOpen(false)
    // The draft is dropped on the way out: the stored value is the truth
    // again, and a half-ticked selection must not survive a cancel.
    setDraft(poolIds(config))
  }

  // ★ THE DRAFT IS UPDATED FROM THE PREVIOUS VALUE, NOT FROM THIS RENDER'S
  // COPY OF IT. Two ticks in the same breath would otherwise both read the
  // same stale list, and the second one would drop the first.
  const togglePoolItem = function (id) {
    setDraft(function (previous) {
      const list = Array.isArray(previous) ? previous : []
      return list.indexOf(id) === -1
        ? list.concat([id])
        : list.filter(function (other) { return other !== id })
    })
  }

  const poolAll = function () {
    setDraft(entries.map(function (entry) { return entry.id }))
  }

  const poolNone = function () {
    setDraft([])
  }

  // ★ THE WRITE. `pool` is a list of material ids; an empty list means the
  // whole library, which is what the store does with it.
  const confirmPool = function () {
    const ids = Array.isArray(draft) ? draft.slice() : []
    setPoolOpen(false)
    setOption('boot', 'pool', ids)
  }

  // ★ OPENING THE MATERIAL PICKER.
  //
  // The list comes from the catalog route, so it is re-read on every open: a
  // material imported since the panel loaded must be in the list the user is
  // looking at. The draft starts from what is STORED, so cancelling really
  // cancels.
  const openMedia = function (key) {
    const slots = config !== null && config !== undefined && config.slots !== undefined ? config.slots : {}
    const slot = slots[key] !== undefined ? slots[key] : {}
    const current = typeof slot.mediaId === 'string' && slot.mediaId !== '' ? slot.mediaId : null
    setMediaSurface(key)
    setMediaDraft(current)
    setOptimize(null)
    setMediaOpen(true)
    readCatalog(setCatalog, setError)()
  }

  const closeMedia = function () {
    setMediaOpen(false)
    setMediaDraft(null)
    setOptimize(null)
    setDeleteRequest(null)
    setDeleteStatus(null)
  }

  const pickMedia = function (id) {
    setMediaDraft(id)
  }

  // ★ THE WRITE. The shape is the one the slots route already takes:
  // `{ slot, mediaId }` — the same shape the flat list used to write.
  const confirmMedia = function () {
    const key = mediaSurface
    const id = mediaDraft
    setMediaOpen(false)
    setOptimize(null)
    if (key === null || key === undefined || id === null || id === undefined || id === '') return
    select(key, id)
  }

  // ★ THE OPTIMIZE CALL.
  //
  // The Host rewrites the file in place and answers with the entry it now
  // holds — the same shape the catalog publishes — so the row is redrawn with
  // the size the file REALLY has. A card that guessed the new size would
  // print a number the catalog does not agree with.
  //
  // ★ THE HOST'S OWN SENTENCE IS SHOWN. The refusal says which of the three
  // reasons it was (too big, not an mp4, the rewrite failed), and that is the
  // part the user can act on — so it is printed, not swallowed.
  const optimizeMedia = function (id) {
    const known = entries.filter(function (item) { return item.id === id })[0]
    const name = known !== undefined ? known.name : id
    setOptimize({ id: id, state: 'busy', text: '正在优化「' + name + '」…' })
    fetch(OPTIMIZE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: id }),
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body }
        }).catch(function () {
          return { ok: response.ok, body: null }
        })
      })
      .then(function (result) {
        const body = result.body
        if (result.ok !== true || body === null || body === undefined || body.ok !== true) {
          const why = body !== null && body !== undefined && typeof body.error === 'string' && body.error !== ''
            ? body.error
            : '宿主没有说明原因。'
          setOptimize({ id: id, state: 'error', text: '优化失败：' + why })
          return
        }
        const updated = body.entry !== null && body.entry !== undefined && typeof body.entry === 'object'
          ? body.entry
          : null
        if (updated !== null) {
          setCatalog(function (previous) {
            if (previous === null || previous === undefined) return previous
            const list = Array.isArray(previous.entries) ? previous.entries : []
            return Object.assign({}, previous, {
              entries: list.map(function (item) {
                return item.id === id ? Object.assign({}, item, updated) : item
              }),
            })
          })
        }
        const message = typeof body.message === 'string' && body.message !== ''
          ? body.message
          : '优化完成。'
        setOptimize({
          id: id,
          state: body.status === 'already' ? 'already' : 'done',
          text: message,
        })
      })
      .catch(function () {
        setOptimize({ id: id, state: 'error', text: '优化失败：连不上宿主路由。' })
      })
  }

  // ★ THE SLOTS, READ AGAIN.
  //
  // The Host clears a slot when the material it pointed at is deleted, and
  // the card has to show that instead of the value it had. A card that keeps
  // the old `mediaId` would claim a material the library no longer holds.
  const refreshSlots = function () {
    return fetch(SLOTS_URL, { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null })
      .then(function (payload) {
        if (payload === null || payload === undefined || payload.config === undefined) return null
        setConfig(payload.config)
        return payload.config
      })
      .catch(function () { return null })
  }

  // ★ THE SURFACES THAT ARE PLAYING THIS MATERIAL.
  //
  // A material the background is playing is a material the user cannot delete
  // without changing the background — so the confirmation says so BEFORE the
  // delete, not after it.
  const surfacesUsing = function (id) {
    const slots = config !== null && config !== undefined && config.slots !== undefined ? config.slots : {}
    const out = []
    for (const slot of MEDIA_SLOTS) {
      const current = slots[slot.key] !== undefined ? slots[slot.key] : {}
      if (current.mediaId === id) out.push(slot.key)
    }
    return out
  }

  // ★ THE ASK. The row's button only opens the confirmation sheet.
  const requestDelete = function (id) {
    const known = entries.filter(function (item) { return item.id === id })[0]
    const name = known !== undefined ? known.name : id
    const using = surfacesUsing(id)
    const message = '删掉「' + name + '」？删了就找不回来了。'
      + (using.length === 0
        ? ''
        : '「' + using.map(mediaSurfaceLabel).join('」「') + '」正在用它，删了会把那个槽位清空。')
    setDeleteRequest({ id: id, name: name, message: message, error: '' })
  }

  // ★ THE CANCEL. It closes the sheet and NOTHING ELSE HAPPENS: no request,
  // no change, and the list is exactly as it was.
  const cancelDelete = function () {
    setDeleteRequest(null)
  }

  // ★ THE DELETE ITSELF. It runs only from the confirmation sheet.
  const confirmDelete = function () {
    const target = deleteRequest
    if (target === null || target === undefined) return
    setDeleteBusy(true)
    deleteMaterialRequest(target.id)
      .then(function (result) {
        setDeleteBusy(false)
        if (result.ok !== true) {
          // ★ THE HOST'S SENTENCE, AS IT IS.
          const why = result.body !== null && result.body !== undefined
            && typeof result.body.error === 'string' && result.body.error !== ''
            ? result.body.error
            : (result.offline === true ? '连不上宿主路由。' : '宿主没有说明原因。')
          setDeleteRequest({
            id: target.id,
            name: target.name,
            message: target.message,
            error: why,
          })
          return null
        }
        // ★ THE MATERIAL LEAVES THE LIST, RIGHT NOW.
        setCatalog(function (previous) {
          if (previous === null || previous === undefined) return previous
          const list = Array.isArray(previous.entries) ? previous.entries : []
          return Object.assign({}, previous, {
            entries: list.filter(function (item) { return item.id !== target.id }),
          })
        })
        // ★ AND THE DRAFT, IF IT WAS POINTING AT THE MATERIAL THAT IS GONE.
        setMediaDraft(function (previous) { return previous === target.id ? null : previous })
        setDeleteRequest(null)
        const cleared = result.body !== null && result.body !== undefined
          && Array.isArray(result.body.clearedSlots)
          ? result.body.clearedSlots
          : []
        setDeleteStatus({
          state: 'done',
          text: '已删除「' + target.name + '」。'
            + (cleared.length === 0
              ? ''
              : '「' + cleared.map(mediaSurfaceLabel).join('」「') + '」的槽位已经清空了。'),
        })
        // ★ AND THE SLOTS ARE READ AGAIN, so the surface shows 「未选择」
        // instead of the material that is no longer there.
        return refreshSlots()
      })
  }

  return h('div', { style: S.panel, 'data-appearance-card': 'true' },
    // ★ THE CARD. One surface, the head on top of it, everything else nested
    // inside it. The card used to be a title strip of its own — 「外观媒体 /
    // 版本 0.1.0 / 素材 14 条」 — which repeated the title the page already
    // prints above it and made the whole thing read as two things.
    h('div', { style: S.card, 'data-card': 'true' },
      h('button', {
        type: 'button',
        style: S.cardHead,
        'aria-expanded': cardOpen,
        'data-card-head': 'true',
        onClick: function () { setCardOpen(cardOpen !== true) },
      },
        CardAvatar(),
        h('span', { style: S.cardHeadText },
          h('span', { style: S.cardTitle, 'data-card-title': 'true' }, '外观媒体'),
          h('span', { style: S.cardDesc, 'data-card-desc': 'true' }, CARD_DESCRIPTION)),
        // ★ THE META LINE. The version and the library count, on one small
        // line at the head's right — not a card of their own.
        h('span', { style: S.cardMeta, 'data-card-meta': 'true' },
          busy ? '写入中…' : ('版本 ' + PLUGIN_VERSION + ' · 素材 ' + String(entries.length) + ' 条')),
        h('span', {
          style: cardOpen ? { ...S.chev, ...S.chevOpen } : S.chev,
          'data-card-chevron': 'true',
          'aria-hidden': 'true',
        })),
      cardOpen
        ? h('div', { style: S.cardBody, 'data-card-body': 'true' },
          error === '' ? null : h('div', { style: S.errorLine, role: 'status' }, error),
          SurfaceOverview({
            surfaces: SURFACES,
            config: config,
            entries: entries,
          }),
          SURFACES.map(function (surface) {
            return h('div', { key: surface.key },
              SurfaceGroup({
                surface: surface,
                config: config,
                entries: entries,
                busy: busy,
                open: groups[surface.key] === true,
                onExpand: expand,
                onToggle: toggle,
                onOption: setOption,
                onOpenPool: openPool,
                onOpenMedia: openMedia,
              }))
          }))
        : null),
    poolOpen
      ? PoolDialog({
        entries: entries,
        draft: draft,
        onToggle: togglePoolItem,
        onAll: poolAll,
        onNone: poolNone,
        onConfirm: confirmPool,
        onClose: closePool,
      })
      : null,
    // ★ THE MATERIAL PICKER. One dialog for the three surfaces: which surface
    // it configures travels with the state, so the card opens ONE picker
    // rather than three.
    mediaOpen
      ? MediaPickerDialog({
        entries: entries,
        surface: mediaSurface === null ? '' : mediaSurface,
        surfaceLabel: mediaSurfaceLabel(mediaSurface),
        draft: mediaDraft,
        currentId: mediaSurfaceId(config, mediaSurface),
        previewing: previewId,
        status: optimize,
        deleteRequest: deleteRequest,
        deleteBusy: deleteBusy,
        deleteStatus: deleteStatus,
        onPick: pickMedia,
        onPreview: togglePreview,
        onOptimize: optimizeMedia,
        onDeleteRequest: requestDelete,
        onDeleteConfirm: confirmDelete,
        onDeleteCancel: cancelDelete,
        onConfirm: confirmMedia,
        onCancel: closeMedia,
      })
      : null)
}

/**
 * One library row: the material's name, its size, its kind, where it came
 * from, and a delete control.
 *
 * ★ THE ROW'S ID IS THE ID THE SERVER ANSWERED WITH. It is put in a
 * `data-media-id` attribute so that a browser check can compare it with the
 * upload response's `entry.id`: if the two ever differ, the row points at a
 * file the media route does not serve.
 *
 * @param entry - one public catalog entry.
 * @param busy - whether a request is in flight.
 * @param onRemove - the delete action.
 * @returns the row element.
 */
function LibraryRow(entry, busy, onRemove) {
  const kind = entry.kind === 'image' ? '图片' : '视频'
  const source = entry.source === 'upload' ? '上传' : '手放'
  return h('div', { style: S.row, key: entry.id, 'data-media-id': entry.id },
    h('span', { style: S.name }, entry.name),
    h('span', { style: S.badge }, kind),
    h('span', { style: S.badge }, source),
    h('span', { style: S.note }, formatBytes(entry.bytes)),
    h('button', {
      type: 'button',
      style: { ...S.button, borderColor: C.warn, color: C.warn },
      disabled: busy,
      'data-media-remove': entry.id,
      onClick: function () { onRemove(entry.id) },
    }, '删除'))
}

/**
 * Format a byte count for a human.
 *
 * @param bytes - the size in bytes.
 * @returns a short string.
 */
function formatBytes(bytes) {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
  if (value < 1024) return String(value) + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB'
  return (value / 1024 / 1024).toFixed(1) + ' MiB'
}

/**
 * The media library: import, list, delete.
 *
 * The import sends the RAW BYTES with the file's own MIME type and its name
 * in the `X-Dsh-Filename` header — not a form. The server does not parse
 * multipart bodies, and a `FormData` upload would arrive as a body it
 * cannot read.
 *
 * ★ THE SERVER'S ERROR TEXT IS SHOWN. A refused upload that fails silently
 * is a refused upload the user cannot fix.
 *
 * @returns the panel element.
 */
function MediaLibraryPanel() {
  const catalogState = React.useState(null)
  const catalog = catalogState[0]
  const setCatalog = catalogState[1]
  const errorState = React.useState('')
  const error = errorState[0]
  const setError = errorState[1]
  const busyState = React.useState(false)
  const busy = busyState[0]
  const setBusy = busyState[1]
  // ★ WHICH MATERIAL THE USER ASKED TO DELETE, AND WHAT THE HOST SAID.
  const deleteTargetState = React.useState(null)
  const deleteTarget = deleteTargetState[0]
  const setDeleteTarget = deleteTargetState[1]

  const reload = React.useCallback(function () {
    // ★ The reader must be CALLED, not just returned. `readCatalog` returns the
    // function that performs the read; returning it made every caller believe
    // the read had happened while nothing was ever fetched — the panel sat on
    // "0 entries" and never refreshed after an import or a removal.
    return readCatalog(setCatalog, setError)()
  }, [])

  React.useEffect(function () {
    reload()
  }, [reload])

  const upload = function (event) {
    const input = event.target
    const file = input.files && input.files.length > 0 ? input.files[0] : null
    if (file === null || file === undefined) return
    setBusy(true)
    setError('')
    fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': file.type === '' ? 'application/octet-stream' : file.type,
        // A header value must be latin-1, and a Chinese file name is not, so
        // the name travels percent-encoded and the server decodes it.
        'X-Dsh-Filename': encodeURIComponent(file.name),
      },
      body: file,
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body }
        })
      })
      .then(function (result) {
        if (result.ok !== true) {
          const message = result.body && typeof result.body.error === 'string'
            ? result.body.error
            : '上传失败。'
          setError(message)
          return null
        }
        return reload()
      })
      .catch(function () {
        setError('上传失败：连不上宿主路由。')
        return null
      })
      .then(function () {
        setBusy(false)
        // Reset the picker, so the same file can be imported again.
        try {
          input.value = ''
        } catch {
          /* the input is already gone */
        }
      })
  }

  // ★ THE DELETE. The row's button only ASKS; the confirmation sheet is what
  // sends the request. A material is the user's own file and there is no undo,
  // so one click must never be enough.
  const remove = function (id) {
    const known = entries.filter(function (item) { return item.id === id })[0]
    const name = known !== undefined ? known.name : id
    setDeleteTarget({
      id: id,
      name: name,
      message: '删掉「' + name + '」？删了就找不回来了。',
      error: '',
    })
  }

  const cancelRemove = function () {
    setDeleteTarget(null)
  }

  const confirmRemove = function () {
    const target = deleteTarget
    if (target === null || target === undefined) return
    setBusy(true)
    deleteMaterialRequest(target.id)
      .then(function (result) {
        if (result.ok !== true) {
          // ★ THE HOST'S SENTENCE, AS IT IS.
          const why = result.body !== null && result.body !== undefined
            && typeof result.body.error === 'string' && result.body.error !== ''
            ? result.body.error
            : (result.offline === true ? '连不上宿主路由。' : '删除失败。')
          setDeleteTarget({
            id: target.id,
            name: target.name,
            message: target.message,
            error: why,
          })
          return null
        }
        setDeleteTarget(null)
        setError('')
        return reload()
      })
      .then(function () {
        setBusy(false)
      })
  }

  const entries = catalog !== null && Array.isArray(catalog.entries) ? catalog.entries : []
  const revision = catalog !== null && typeof catalog.revision === 'number' ? catalog.revision : 0

  return h('div', { style: S.panel, 'data-media-library': 'appearance-media' },
    h('div', { style: S.panelCard },
      h('div', { style: S.sectionTitle }, '素材库'),
      h('div', { style: S.row },
        h('input', {
          type: 'file',
          accept: ACCEPTED_TYPES,
          style: S.input,
          disabled: busy,
          'data-media-import': 'appearance-media',
          onChange: upload,
        }),
        h('span', { style: S.note }, busy ? '处理中…' : '导入一个视频或图片（≤ 96 MiB）')),
      h('div', { style: S.row },
        h('span', { style: S.note }, '条目 ' + String(entries.length)),
        h('span', { style: S.note }, '清单版本号 ' + String(revision))),
      error === '' ? null : h('div', { style: { ...S.note, color: C.warn }, role: 'status' }, error)),

    h('div', { style: S.panelCard },
      entries.length === 0
        ? h('div', { style: S.empty }, '还没有素材。')
        : entries.map(function (entry) { return LibraryRow(entry, busy, remove) })),
    // ★ THE CONFIRMATION SHEET. Nothing is deleted until it says 删除.
    deleteTarget === null || deleteTarget === undefined
      ? null
      : DeleteConfirmDialog({
        message: deleteTarget.message,
        error: deleteTarget.error === undefined ? '' : deleteTarget.error,
        busy: busy,
        onConfirm: confirmRemove,
        onCancel: cancelRemove,
      }))
}

/**
 * The section under this bundle's own page.
 *
 * ★ THE GUARD JUDGES THE SUBJECT, AND ONLY THE SUBJECT.
 *
 * This slot's owner props are `PluginDetailProps` = `{ subject }`
 * (`slot-contract.ts:68-71`). There is NO `view` prop here — `view` belongs to
 * `PluginConfigViewProps`, which serves the Official group's card slot, this
 * bundle's configuration slot and a row's configuration slot. A guard that
 * tested `props.view` would render nothing, ever, and no offline assertion
 * would notice.
 *
 * The Host renders this slot for a bundle, for a row and for an official plugin
 * (`PluginManagerPage.tsx:667` / `:712` / `:838`); the subject tells us which,
 * and this panel has something to say about exactly one of them.
 *
 * @param props - the host's props.
 * @returns the section, or null.
 */
function MediaLibrarySection(props) {
  const subject = props !== undefined && props !== null ? props.subject : undefined
  if (subject === undefined || subject === null) return null
  if (subject.kind !== 'bundle') return null
  const pkg = subject.pkg
  if (pkg === undefined || pkg === null || pkg.name !== PACKAGE_NAME) return null
  return h(MediaLibraryPanel)
}

/**
 * One configuration field: a native input and a save button.
 *
 * The WRITE goes through the host's own form (`ConfigForm.set`), which queues
 * it behind the host's revision fence and lets the host's configuration
 * editor validate it. The plugin never writes the profile's patch file.
 *
 * @param field - the field name.
 * @param label - the field label.
 * @param hint - the field hint.
 * @param value - the current value.
 * @param t - the locale reader.
 * @param onSave - the write action.
 * @returns the row element.
 */
function ConfigField(field, label, hint, value, t, onSave) {
  const draftState = React.useState(String(value === undefined ? '' : value))
  const draft = draftState[0]
  const setDraft = draftState[1]

  return h('div', { style: { ...S.row, alignItems: 'flex-start' }, key: field },
    h('span', { style: S.name }, label),
    h('input', {
      type: 'text',
      className: 'dsham-field',
      'data-field': field,
      value: draft,
      style: S.input,
      'aria-label': label,
      onChange: function (event) { setDraft(event.target.value) },
    }),
    h('button', {
      type: 'button',
      style: S.button,
      onClick: function () { onSave(field, draft) },
    }, t('save')),
    h('span', { style: S.note }, hint))
}

/**
 * This bundle's configuration form, on the bundle's own page.
 *
 * The host renders `plugins.bundle.config` with `view: 'page'` and NO form of
 * its own, so the entry supplies the host's form through its `inject` face.
 * The form is the host's `ConfigForm`: its snapshot carries the values the
 * Host resolved for this entry's volatile fields, and its `set` is the host's
 * write queue.
 *
 * @param props - the host's props, including the injected form.
 * @returns the form, or nothing when the Host is not serving the namespace.
 */
function BundleConfigPanel(props) {
  const t = reader(props)
  const form = props !== undefined && props !== null ? props.form : undefined
  const snapshotState = React.useState(null)
  const snapshot = snapshotState[0]
  const setSnapshot = snapshotState[1]
  const messageState = React.useState('')
  const message = messageState[0]
  const setMessage = messageState[1]

  React.useEffect(function () {
    if (form === undefined || form === null || typeof form.subscribe !== 'function') return
    const update = function () {
      try {
        setSnapshot(form.getSnapshot())
      } catch (error) {
        /* a mirror that cannot be read is reported by the host, not here */
      }
    }
    update()
    const off = form.subscribe(update)
    return function () {
      if (typeof off === 'function') off()
    }
  }, [form])

  if (form === undefined || form === null) return null

  const value = snapshot !== null && snapshot !== undefined && snapshot.value !== null
    && typeof snapshot.value === 'object' ? snapshot.value : {}

  const save = function (field, raw) {
    if (typeof form.set !== 'function') return
    setMessage(t('saving'))
    Promise.resolve(form.set(field, raw)).then(function (accepted) {
      setMessage(accepted === true ? t('saved') : t('saveFailed'))
    }).catch(function () {
      setMessage(t('saveFailed'))
    })
  }

  return h('div', { style: S.panel, 'data-plugin-config': 'appearance-media' },
    h('div', { style: S.panelCard },
      h('div', { style: S.sectionTitle }, t('title')),
      ConfigField('dataDir', t('dataDirLabel'), t('dataDirHint'), value.dataDir, t, save),
      message === '' ? null : h('div', { style: S.note, role: 'status' }, message)))
}

/**
 * Contribute the panel and the form to the pages that own them.
 *
 * The registration is gated on the Host actually SERVING this entry's
 * namespace: `configForms.whileServed` fires while the Host serves it and
 * withdraws when it stops. A profile whose schema package is missing shows
 * nothing at all rather than an inert panel.
 *
 * @param ctx - the client plugin context.
 */
function apply(ctx) {
  if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return

  ctx.inject(['slots', 'locale', 'configForms'], function (owner) {
    try {
      const slots = serviceAt(owner, 'slots', ctx)
      const locale = serviceAt(owner, 'locale', ctx)
      const forms = serviceAt(owner, 'configForms', ctx)
      if (slots === undefined || slots === null || typeof slots.inject !== 'function') return
      if (forms === undefined || forms === null || typeof forms.whileServed !== 'function') return

      // The dictionary namespace.
      //
      // Registering one namespace twice throws, and this callback can run more
      // than once when the services re-arrive. The failure is caught HERE, so
      // a second registration cannot take the panel down with it: an exception
      // thrown out of this effect would abort the rest of `apply` and the
      // panel would silently disappear.
      if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
        const dictionaries = function () {
          try {
            return locale.register(LOCALE_NAMESPACE, { zh: DICTIONARY_ZH, en: DICTIONARY_EN })
          } catch (error) {
            console.warn('appearance-media: locale namespace not registered', error)
            return undefined
          }
        }
        if (typeof owner.effect === 'function') owner.effect(dictionaries, 'appearance-media: dictionaries')
        else dictionaries()
      }
      if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
        try {
          translate = locale.bind(LOCALE_NAMESPACE)
        } catch (error) {
          /* keep the built-in reader */
        }
      }
      const t = translate

      // The registrations this panel owns.
      let registrations = []

      const contribute = function () {
        // Registering the same id into the same list slot twice throws, and that
        // throw lands inside the slot ledger's store notification — it kills the
        // card's updates while leaving the rendered DOM in place. So the
        // registration is idempotent here.
        if (registrations.length > 0) return
        const owned = []
        try {
          owned.push(slots.inject(SLOT_SECTION, function () {
            return slots.register({
              name: SLOT_SECTION,
              id: SETTINGS_NAMESPACE,
              order: 60,
              label: function () { return t('title') },
            }, AppearancePanel)
          }))
          // The section under THIS bundle's own page: the media library.
          //
          // It is a LIST slot, so it needs an id; the id is the profile entry
          // id, the same string the settings namespace uses.
          owned.push(slots.inject(SLOT_DETAIL_SECTION, function () {
            return slots.register({
              name: SLOT_DETAIL_SECTION,
              id: SETTINGS_NAMESPACE,
              order: 60,
              label: function () { return t('title') },
            }, MediaLibrarySection)
          }))
          // ★ THE PLUGINS PAGE CARD.
          //
          // This is the slot the boot-animation plugin uses, and the reason
          // its card sits in the Plugins page — with the icon, the title and
          // the description from the locale file — while ours was a plain
          // entry in the Settings page's left-hand list.
          //
          // ★ THE `inject` FACE CARRIES THE RENDERER. The page renders the
          // entry with `React.createElement`, so the component cannot close
          // over this module's React: it reads it from the face instead.
          owned.push(slots.inject(SLOT_PLUGIN_ITEM, function () {
            return slots.register({
              name: SLOT_PLUGIN_ITEM,
              id: SETTINGS_NAMESPACE,
              order: 60,
              label: function () { return t('title') },
              locale: LOCALE_NAMESPACE,
              inject: function () { return { runtime: React, scope: forms.get(SETTINGS_NAMESPACE) } },
            }, AppearanceEntry)
          }))
          // The bundle's own configuration. Keyed by the PACKAGE NAME, which
          // is what the host looks the bundle up by.
          //
          // There is NO registration in the Official group's card slot: that
          // slot is the host's own list of official plugins, and an ordinary
          // installed bundle already gets its card from the host — registering
          // there as well produced two cards for the same plugin.
          owned.push(slots.inject(SLOT_BUNDLE_CONFIG, function () {
            return slots.register({
              name: SLOT_BUNDLE_CONFIG,
              key: PACKAGE_NAME,
              locale: LOCALE_NAMESPACE,
              inject: function () { return { form: forms.get(SETTINGS_NAMESPACE) } },
            }, BundleConfigPanel)
          }))
        } catch (error) {
          console.warn('appearance-media: panel not registered', error)
        }
        registrations = owned
      }

      const withdraw = function () {
        const owned = registrations
        registrations = []
        for (const dispose of owned) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch (error) {
            console.warn('appearance-media: panel not withdrawn', error)
          }
        }
      }

      // ★ THE SURFACES ATTACH HERE — AND ONLY HERE.
      //
      // A surface that plays media must go through the arbitration point:
      // `apply(slot, entry)` to start, `release(slot)` to stop. It must NOT
      // keep its own copy of "what is playing": the arbitration point is the
      // single source of truth, and two copies drift.
      //
      // `report(slot, fields)` is how a surface publishes its OWN facts (the
      // background's `hidden` and `videoCount`) into `state().slots[slot]`.
      //
      // ★ THE THREE REGISTRATIONS ABOVE ARE NOT SURFACES. They render panels
      // and forms; they never play media. So the absence of an arbitration
      // point must NOT take the settings panel with it — it only means "this
      // build has no surfaces yet" (Task 5/6/7 add them).
      const controller = arbitrationPoint()
      if (controller === null) {
        console.warn('appearance-media: 没有仲裁点，本插件不注册任何表面。')
      } else {
        // ★ The subscription is guarded on its own. A throw here would escape
        // the inject callback, and the three registrations above would never
        // run — the panels would vanish for a reason that has nothing to do
        // with panels.
        try {
          const off = controller.on('change', function (payload) {
            latestChange = payload
          })
          if (typeof owner.effect === 'function') {
            owner.effect(function () {
              try {
                if (typeof off === 'function') off()
              } catch (error) {
                console.warn('appearance-media: controller subscription not withdrawn', error)
              }
            }, 'appearance-media: controller subscription')
          }
        } catch (error) {
          console.warn('appearance-media: controller subscription failed', error)
        }
      }

      const serve = function () {
        return forms.whileServed([SETTINGS_NAMESPACE], function () {
          contribute()
          return withdraw
        })
      }

      if (typeof owner.effect === 'function') owner.effect(serve, 'appearance-media: panel')
      else serve()
    } catch (error) {
      console.warn('appearance-media: client half failed', error)
    }
  })
}

exports.apply = apply

/**
 * The arbitration point, for the surfaces (Task 5/6/7).
 *
 * Exported so a surface can look it up at the moment it needs it — the
 * injected row may land after this module is evaluated.
 */
exports.arbitrationPoint = arbitrationPoint

/**
 * The last 'change' payload the arbitration point published.
 * @returns {object|null} the payload, or null.
 */
exports.lastChange = lastChange
