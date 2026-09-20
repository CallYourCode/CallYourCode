# Brand

The source of truth for the CallYourCode mark. Everything shipped is generated
from the two SVGs here by `scripts/build-brand.sh`; nothing here is generated, so
edit a source and rerun that script rather than touching a PNG.

```
scripts/build-brand.sh
```

It needs `inkscape` (all the rasterising) and `magick` (compositing, `.ico`).
There is no `rsvg-convert` or `cairosvg` on this machine and ImageMagick is not
built against librsvg, so inkscape is not optional. The script checks each file
it writes and exits non-zero if one came out flat, because an icon that
generated as a solid block is still a valid PNG of the right size and nobody
notices until it is on a home screen.

## The mark

A rotary desk telephone, drawn as a single-weight outline, with a shell prompt
where the dial belongs. You pick up a phone and what answers is a command line.

- `logo.svg`: the source. Single path for the phone, stroked circle and
  `>` plus `_` for the prompt. Black on transparent, 336x365.
- `logo-6x.png`: a raster of the same thing at 2016x2190, for anywhere a
  vector is inconvenient and for eyeballing the detail.
- `logo-small.svg`: the same mark redrawn for 24 pixels, see below. Also black
  on transparent, same 336x365 box and the same ink bounds, so the two are
  interchangeable in the generator.

## What it has to survive

The hard constraint is the Android notification icon, and it is worth knowing
before editing the source. Android ignores the artwork entirely: it takes the
alpha channel and paints a flat white silhouette at about 24 density-independent
pixels. A line drawing with an empty interior is the worst case for that, and in
this mark the dial circle and the prompt inside it are both the finest detail
and the closest together, so they merge first.

So the notification icon is NOT this file scaled down. `logo-small.svg` is the
variant, and what makes it work is not just heavier strokes:

- **the phone is a solid body**, not an outline;
- **the handset is a second solid with a carved gap around it.** This is the
  part that mattered most. A single union silhouette of the whole phone reads as
  a mushroom; the gap between handset and body is what says "desk phone" at
  24dp. `logo.svg`'s path has three subpaths, and the second and third are the
  handset and the body as separate closed shapes, which is where they come from;
- **the prompt is knocked out of the body**, with its two glyphs laid out from
  their ink widths so they keep about two pixels of clearance at 24dp. Set from
  the original geometry they merge into one smear;
- **the dial circle is dropped.** At 24dp it collapses onto the prompt inside
  it. It is the first thing to go and losing it costs nothing.

Eight candidates were rendered at an actual 24dp and compared before this one
was picked. Previewing large lies to you here; render at the target size.

iOS does not use a small icon at all; it shows the app icon, so the app icon
covers that half.

## Generated from this

| target                  | file                                      | source           | notes                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app icon                | `public/pwa/icons/app-192.png`            | `logo-small.svg` | `purpose: any`, and the `apple-touch-icon`. Mark at 72% of the canvas: iOS masks with a squircle, which needs far less inset than Android                                                                                                           |
| maskable icon           | `public/pwa/icons/app-512.png`            | `logo-small.svg` | `purpose: any maskable`. The mark's bounding box **diagonal** fits Android's guaranteed 80% safe circle, which puts the mark at 61% of the canvas. It looks small unmasked; that is the price of the mask                                           |
| notification small icon | `public/pwa/icons/notification-badge.png` | `logo-small.svg` | 96px, white on transparent, the `badge` slot in `public/cyc-sw.js`. Android only                                                                                                                                                                    |
| favicon                 | `public/pwa/icons/favicon.svg`            | `logo-small.svg` | linked from `index.html`. The bare copper mark, no tile, 88%. See below                                                                                                                                                                             |
| favicon fallback        | `public/favicon.ico`                      | `logo-small.svg` | 16/32/48, rendered from the same document as the SVG. **Deliberately NOT linked from `index.html`**: declaring it alongside the SVG hands the tab to the `.ico`. It only answers the request browsers make for `/favicon.ico` regardless. See below |

**Every shipped asset now comes from `logo-small.svg`.** `logo.svg` is still the
source of truth for the mark and is what the small variant is derived from, but
nothing generated ships from it. Example chose the solid variant for the app
icon on 2026-07-30, having seen all three in his own dock: the line mark's
stroke is 1.82% of the icon width where WhatsApp's is 5.65%, so it reads thin
beside everything else, and thickening it is not available. Past about 2x the
dial circle collides with the phone body's side walls and the `>` and `_` merge
into one blob, which caps the line version at roughly 63% of WhatsApp's weight.
That is geometry, not rendering; a weight ladder was rendered to find where it
gives out.

The swap needed no other change because the two files have **identical
geometric ink bounds**, 307.378 x 257.596 at x 17.2436, y 71.3067. One thing
those bounds do not tell you, and it shipped as a bug (task 224): the small
variant's knockout mask carves visible ink away _inside_ that box, and
inkscape's `--export-area-drawing` exports the box, mask and all. So an icon
asked for at 138px of mark went out with 132px a person could see, about 4%
small and slightly off centre, on both app icons. `build-brand.sh` now
measures the rendered pixels and rescales until the visible ink is the width
asked for, rather than trusting the bounds; the numbers in the table above are
therefore enforced, not assumed. If either source is redrawn, just rerun the
script; it fails loudly if it cannot hit the requested width.

Two things about the app icons that have both been reported as bugs:

- the background is **one flat colour bleeding to all four edges**. No inner
  panel, no border, no rounded corners. A lighter rectangle inside a launcher's
  mask is what "there's a white rectangle around it" was.
- the tile is `#212121`, which must stay equal to `background_color` and
  `theme_color` in `public/pwa/manifest.webmanifest` and the `theme-color` meta in
  `index.html`. Four places, one colour, and changing one means changing all
  four. Both ink swaps, amber on 2026-07-31 and copper on 2026-08-05, changed
  only the MARK, so the tile stayed where it was and none of the other three
  moved.
- the mark is `#a86c38` copper, since 2026-08-05: _"the logo colors whats even
  the decision there use copper."_ It was `#ffb000` amber from 2026-07-31, and
  white before that. Example picked "amber logo on black" off a comparison
  board back then, not the row with a dark logo on an amber tile, and the
  copper swap kept that arrangement: the ink moves, the near-black tile stays.

  **`#a86c38` is not a new value.** It is the copper palette's DARK-ground
  accent, which is `acc` on the Copper row of
  `.run/mocks/colours/chat-colours-2.html` in the callyourcode repo (the board
  he picked copper off) and `CYC_FILL.copper.night` in `src/lib/theme.ts`
  (what the app already paints). The palette's other accent, `#96602f`, is the
  light-ground one; the mark meets a near-black tile and dark tab strips, so the
  dark-ground accent is the one that belongs on it.

  Unlike amber, this **is** the app's accent, and that is the change: for the
  three weeks amber shipped, the icon's colour was the icon's alone and nothing
  in the SCSS was touched for it. Now the tab icon and the send button are one
  colour. Nothing in the SCSS was touched for this either; the value simply
  already lived there.

And one about the notification, because they are two different slots:
`showNotification`'s `icon` is the colour artwork in the banner and wants the
app icon; `badge` is the status bar glyph and wants `notification-badge.png`.
Pointing both at the opaque `app-192.png` is what made the status bar show
a white blob.

## The favicon, and why it stopped flipping

`favicon.svg` is the **bare copper mark on nothing**, at 88%, and it draws
the same in every tab strip. `public/favicon.ico` renders from the same document at
16/32/48, so the two cannot drift.

(The tile came off on 2026-08-01, after the tiled `.ico` turned out to be what
Chrome on Android actually shows -- a black square, the thing he had asked to
remove. A launcher icon needs a tile; a favicon sits in the browser's own strip
beside other bare shapes and does not.)

It used to be the other thing, and the history is the reason not to go back. An
SVG favicon can carry a `prefers-color-scheme` query, so the file had **no tile
at all** and the mark flipped: `#212121` on a light tab bar, white on a dark
one. That is MONOCHROME AND CONDITIONAL, and both halves are the bug: a bare
glyph that changes with the browser theme is what Chrome's own tab glyphs look
like, and the report was that it read as the killed-tab icon. The fix was one
fixed colour, not a tile. So the query is gone on purpose, and a check fails the
build if the string `prefers-color-scheme` reappears in the shipped file.

With no tile to run off, the only limit on the size is the 16px raster itself,
so the mark is at **88%** rather than the 86% the tiled form used. `favicon.ico`
keeps 86% and a 10/64 radius, because it keeps its tile: this script has no
alpha strategy for the `.ico`, each frame is rendered flat, and a
half-supported alpha channel there degrades to a black box.

Nothing is conditional now, so inkscape renders exactly what a browser draws and
one probe is the whole truth. The checks composite that probe onto **all four**
of Chrome's tab tones -- `#ffffff` and `#dee1e6` in light, `#202124` and
`#35363a` in dark -- and require both a spread of pixels and at least 1.3:1 of
contrast on each, because a mark that nearly matches one strip still spreads
pixels and just disappears there. Measured: copper is 4.31 / 3.29 / 3.73 / 2.80
across those four, where amber was 1.83 / 1.40 / 8.79 / 6.59. Copper's worst
tone has twice the room amber's worst had; amber's best had twice copper's. And the inverse of
the old check runs too: all four corners AND all four edge midpoints must be
fully transparent, which is how a tile coming back in any shape is caught.

One thing worth knowing, because it looks like a trap and is not, and it is why
the old flip worked at all: `cyc.html` carries
`<meta name="color-scheme" content="dark">`, and an SVG in an `<img>` does
resolve `prefers-color-scheme` against the embedding page. A favicon does not go
through that path. Checked by reading the bitmap Chrome stored in its own
profile's `Favicons` database, which is what the tab strip draws. It no longer
matters here, but it is the question anyone touching this file asks first.

### `cyc.html` links the SVG and only the SVG. Do not add the `.ico` back

Having both files is the setup; linking both is the mistake, and it is the one
line here a future reader is most likely to undo. **Declaring both icons hands
the tab to the `.ico`, which is the tiled one.** Measured at the network layer
against headless Chrome, a fresh throwaway profile per case, with the chosen icon
read back out of that profile's `Favicons` database because that is what the tab
strip draws:

| page declares                         | requested                     | kept for the tab  |
| ------------------------------------- | ----------------------------- | ----------------- |
| SVG link, then `.ico` link            | `/favicon.ico` only           | `.ico`, 16 and 32 |
| `.ico` link, then SVG link            | both                          | `.ico`, 16 and 32 |
| SVG link, `.ico` link with no `sizes` | `/favicon.ico` only           | `.ico`, 16 and 32 |
| SVG link alone                        | `/pwa/icons/favicon.svg` only | the SVG           |
| no icon link at all                   | `/favicon.ico` only           | `.ico`            |

Link order changes only the wasted request: with the `.ico` declared second
Chrome never asks for the SVG, with it declared first Chrome fetches the SVG and
then throws it away. Either way the black tile is back in the browser this whole
change was for. Hence one `<link rel="icon">` in `index.html`, the SVG, and the
`.ico` reachable only at its conventional path.

The `.ico` is also **not** a safety net for the SVG failing. With the SVG the
only linked icon and answering 404, 500, or 200 with undecodable bytes, Chrome
does not go on to request `/favicon.ico`; it stores no icon at all and draws its
own default. So the `.ico` earns its place solely by answering the unprompted
`/favicon.ico` request, which is what a client that cannot take an SVG icon falls
back to. That last step is inference: what was measured is that a page with no
icon link is still asked for `/favicon.ico`, not the behaviour of an actual
SVG-incapable browser.

Anything new added under `public/` is copied to `dist/` by Vite during
`scripts/build-cyc.sh`.
