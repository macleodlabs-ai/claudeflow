# claudeflow brand

One Claude Code session, many threads of work, untangled. The look is the hero image: luminous strands tangle, meet,
and fan out into labelled streams. The ground is neutral, light or dark, so all the colour is in the strands and the
status signals. Bold and joyful, never noisy.

Tokens live at the top of `app/styles.css`. Use the token, never the hex, in CSS. Views that must write a colour into
a style attribute use `STATE_COLOR` / `limitColor` / `color()` in `app/src/views/util.ts`, which point at the same tokens.

## Not Claude

No terracotta, orange-tan or brown-amber surfaces. No cream or beige paper. No serif display type. No sunburst,
asterisk or spark marks. Warm colours appear only as luminous strokes (the peach strand) or as small status signals.

## Palette

### Light and dark

Both schemes come from one set of tokens: each colour is `light-dark(light, dark)`. The page follows the device; the
header switch (`app/src/theme.ts`) cycles device, light, dark and pins the choice with `data-theme` on `<html>`.

### Ground (backgrounds)

Neutral greys with no blue cast. The token names are the old night ramp's.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--night-950` | `#f6f6f8` | `#0b0b0d` | Page edges |
| `--night-900` | `#f6f6f8` | `#111113` | Page background (`--bg`), theme colour |
| `--night-800` | `#ffffff` | `#17171a` | Inputs, sunken areas |
| `--night-700` | `#ffffff` | `#1c1c20` | Cards and panels (`--card`) |
| `--night-600` | `#f1f1f4` | `#25252a` | Raised, hover, selected segment |
| `--night-500` | `#dcdce2` | `#34343b` | Strong lines, empty bar tracks (`--line`) |

Panels: `--glass` / `--glass-strong` are white on light and charcoal on dark, with hairline `--glass-line` borders. Use
glass with `backdrop-filter: blur(12px)` only where something sits over content (usage bar, sticky header, sheets).

### Text

| Token | Light | Dark |
|---|---|---|
| `--text` | `#17171b` | `#f2f2f4` |
| `--text-soft` | `#2b2b31` | `#dcdce0` |
| `--text-dim` | `#55555f` | `#a8a8b2` |
| `--text-faint` | `#6e6e78` | `#8c8c96` (smallest allowed for text) |
| `--ink` | `#111113` | dark text on every bright fill, both schemes |
| `--brand` | `#7c83ff` | focus rings, selection, links; ink on it |

On light, text in a strand colour (stream names, icons) is drawn in a deeper mix of the strand, and status words use
`--running-ink`, `--waiting-ink`, `--done-ink`, `--error-ink`, `--stalled-ink`: the same signals, dark enough to read
on white. Fills (pills, buttons) keep the bright signal with ink text in both schemes.

### Streams (the strands)

Stream colour is identity, not state. It appears as strokes and text: the card's left stripe, the stream name, the
strand in the motif, the dot in a label. Never as a solid chip, pill or badge fill: solid pills belong to status, and
that is the only thing keeping sky from waiting, mint from done and peach from stalled. The first five are the hero's.
Butter became lilac so no strand sits in the yellow/orange family of running and stalled.

| # | Token | Hex | Replaces plugin pastel | ANSI-256 | On night-700 |
|---|---|---|---|---|---|
| 1 | `--stream-sky` | `#7cc8ff` | `#a5d8ff` sky | 117 | 9.6 |
| 2 | `--stream-mint` | `#6ff0c0` | `#b2f2bb` mint | 85 | 12.4 |
| 3 | `--stream-peach` | `#ffb88a` | `#ffd8a8` peach | 216 | 10.3 |
| 4 | `--stream-violet` | `#b9a2ff` | `#d0bfff` lavender | 147 | 8.0 |
| 5 | `--stream-pink` | `#ff94d1` | `#fcc2d7` pink | 212 | 8.6 |
| 6 | `--stream-lilac` | `#d9c6ff` | `#ffec99` butter | 183 | 11.2 |
| 7 | `--stream-aqua` | `#5fe4f2` | `#99e9f2` aqua | 81 | 11.5 |
| 8 | `--stream-orchid` | `#e08cff` | `#ffc9c9` rose | 177 | 7.8 |
| 9 | `--stream-pistachio` | `#b6e6a0` | `#c0eb75` lime | 151 | 12.3 |
| 10 | `--stream-ice` | `#c9d6ff` | `#bac8ff` periwinkle | 189 | 12.1 |

`--flow` is the five-hero gradient (sky, mint, peach, violet, pink). It is a line, never a surface: the wordmark
underline, the ring around the gate's call to action, the strands. Every primary button is `--brand` with ink text;
the gate's adds a 2px flow ring and a brand glow.

The app maps the plugin's pastels to these in `color()` (util.ts), so snapshots need no change. Any other hex a
snapshot sends becomes the nearest strand, so a stream can never arrive in a status colour.

### Status (signals)

Status is a solid fill with ink text, a glyph and an uppercase word, so it never reads as a stream even near one.

| Token | Hex | Glyph | Ink on fill | As text on 700 | Nearest stream (OKLab ΔE) |
|---|---|---|---|---|---|
| `--running` | `#ffd33d` | ● | 13.7 | 12.1 | peach 0.14 |
| `--loop` | outline of `--running` | ↻ | running text on night | 12.1 | |
| `--waiting` | `#4d8dff` | ? | 6.1 | 5.4 | violet 0.15 |
| `--done` | `#2fd67b` | ✓ | 10.3 | 9.1 | mint 0.11 |
| `--error` | `#ff4d6a` | ✗ | 6.1 | 5.4 | pink 0.16 |
| `--stalled` | `#ff8a2a` | ◔ | 8.3 | 7.4 | peach 0.11 |
| `--idle` | `#3a4078` | ○ | `--text` on it 8.5 | use `--text-faint` | far |

Rules: loop is running's outlined twin (transparent fill, 1.5px running ring, running text), so running and loop
never differ by the glyph alone. A stalled card's icon wears the stalled colour, so it reads as needing attention.
Ink (`--on-status`) on every status fill; white on these fills fails AA. Waiting is the colour that asks
for the person, so it gets the strongest treatment: border plus tint on the question panel and on permission cards. Error and Deny share
`--error`; Done, Yes and Allow share `--done`. Tints for panels: `color-mix(in srgb, var(--waiting) 12%, var(--night-700))`.

## Type

- UI: `--font-ui` (system: SF Pro, Segoe UI, Roboto). Sizes `--fs-xs` 11 to `--fs-2xl` 32; body 15/1.4.
- Display: `--font-display` = `ui-rounded` (SF Pro Rounded on Apple), then the system sans. Used for the wordmark
  and gate titles only. The app's CSP is `default-src 'self'` and it loads nothing from elsewhere, so no Google
  Fonts: if a geometric webfont is wanted, self-host Outfit (OFL, weight 600) as a woff2 in `app/` and add it before
  `ui-rounded`.
- Mono: `--font-mono` for tool rows, permission commands.
- Wordmark: `claudeflow`, lowercase, display font, weight 700, 24px on phones and 28px from 820, a 3px flow underline
  with a soft brand glow, tracking -0.02em, `--text` colour. Never in a serif,
  never title case. Lockup: the icon at 1.1x cap height, 8px gap, then the wordmark. Page titles ("Streams", "Pair a
  device") sit beside or under it, in `--font-ui` 800.

## Shape, depth, space

- Radius: `--r-xs` 6 (badges), `--r-sm` 10 (buttons, inputs), `--r-md` 14 (cards), `--r-lg` 20 (gates, sheets),
  `--r-pill` (chips, tabs).
- Shadow: `--shadow-panel` on cards, `--shadow-pop` on sheets and the pair card. Glow is coloured light, not grey:
  `box-shadow: 0 0 18px color-mix(in srgb, var(--c) 35%, transparent)` on a stream's stripe or dot, and
  `--glow-brand` on focus. At most one glowing thing per card.
- Space: `--sp-1` 4, 8, 12, 16, 24, 32, `--sp-7` 48. Page gutter 16 on phones, 24 from 820.
- Width: content max `--page-max` 1200px, centred, from 1280 (sessions sidebar, stream list, detail pane). At 820+ the Streams view is a list and a detail pane;
  the Status view stays one column up to 720px wide. Tap targets stay at least 44px tall everywhere.

## The motif

`app/strands.svg`: six strands tangle on the left, cross, meet at a knot, then fan out into their own lanes, each
ending in a dot. Ghost strands give the tangle depth; a white light runs along them unless motion is reduced.
The icon (`app/icon.svg`, `app/icon.png` 512) is the same story with five thick strands on a night-to-nebula square,
for 180px and up (manifest, apple-touch). `app/mark.svg` is the small-size version (header lockup, favicon): four
strands at stroke 12 that cross once, with big end dots, so it stays legible at 16-34px.

Where it goes:
- Pair page: full width above the QR card. The moment of joy.
- Locked / Pair this device / Not paired gates: a 96-120px strip across the top of the gate card.
- Empty states ("Streams appear as you prompt"): full bleed and full strength, the copy balanced under it. Joy
  belongs most where nothing is happening yet.
- The wide layout's detail pane: a faint (22%) strip at its foot, below the content, never under text.
- Header: the icon in the wordmark lockup. Not behind content: never put strands under text.
- README: the existing hero.jpg already is the motif; screenshots (phone-app, status-card, preview) are retaken after
  the apply phase.

## Motion

- Durations `--dur-fast` 120ms (press), `--dur` 220ms (open, switch), `--dur-slow` 600ms (gate reveal), ease `--ease`.
- What moves: the running spinner, the strand light on gates and the pair page, a card opening, a "sent" check fading.
- What never moves: status chips, numbers, anything you are reading. No bounce, no confetti, no parallax.
- `prefers-reduced-motion: reduce` turns every animation off (global rule in styles.css; strands.svg has its own).
  State must still be readable without motion: the RUNNING badge carries it, not the spinner.

## Voice

Short, warm, plain. Say what happened and what to do. One exclamation mark per screen at most.

| Instead of | Say |
|---|---|
| No sessions yet. Open Claude Code with the streams mod on the Mac. | Nothing flowing yet. Start Claude Code on your Mac. |
| Unlock with your passkey to see your sessions. | Unlock to see your streams. |
| Nothing filed yet. | Quiet so far. |
| ✓ sent | Sent ✓ |

Keep "Claude is working" and "Claude wants to run …": they name the product the person is driving.

## Terminal (plugins/streams)

Stream stripes in the pane come from `PASTELS` in `hooks/classify.ts`. When that file is free, replace its ten
values with the stream hexes above, in the same order (sky, mint, peach, lavender, pink, butter, aqua, rose, lime,
periwinkle). Truecolor terminals get the hex; 256-colour terminals use the ANSI index in the table.

Status words in `hooks/ui/look.ts` (`STATUS_WORD`, `STATE_COLOR`, `limitColor`) are text on the terminal's own
background, which may be light. The app now uses running `#ffd33d`, the terminal's value. Target values for the rest: waiting `#4d8dff` (69), done `#2fd67b` (42),
error `#ff4d6a` (203), stalled `#ff8a2a` (208), idle `#8a90c8` (104). Done is still `#7ee787` in the terminal and `#2fd67b`
in the app: the plugin tests pin `#7ee787`, so look.ts and that assertion must change together (with classify.ts).
