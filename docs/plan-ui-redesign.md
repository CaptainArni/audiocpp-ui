# Plan — UI redesign: the "Studio console"

Replace Studio's stock-Mantine look with a deliberate design layer: a dark
console with a left nav rail, a real surface hierarchy, the brand's own violet
and magenta, and audio-native controls — above all a **custom player**, because
the native `<audio>` element is the single most damaging thing on screen today.

This is a **presentation-layer change**. No backend route, no request shape, no
engine (`callEngine`, `vad`, `callPlayer`, `chunk.ts`) changes. The Android
companion app is untouched.

Everything below marked **verified** was read out of this repo, not assumed.

---

## Status — all six phases shipped

Built and verified on 2026-08-15 against the running backend (Vite dev server
proxied at `AUDIOCPP_API`, then the production build served from
`backend/static`). `npx tsc --noEmit` clean, `npm test` 14/14, `pytest tests`
72/72.

What changed against the plan below, and why:

- **The palette came out of the logo, exactly as hoped.** Decoding
  `assets/logo.png` pixel by pixel gives two dominant hues and nothing else:
  `#a651de` (bubble outline) and `#ef1ac4` (waveform bars). They are now
  `theme.colors.violet[6]` and `magenta[6]`, split by job — violet is chrome,
  magenta is *live audio* (playhead, waveform fill, the playing button, the
  `speaking` phase of the call orb, the render sweep on Generate).
- **The rail did keep every panel mounted.** `Tabs` wraps the whole `AppShell`,
  `Tabs.List` renders inside `AppShell.Navbar` and the panels stay in `Main`. No
  panel file needed a lifecycle change and `callSession` was not touched.
- **`Tabs orientation="vertical"` makes its root a flex row**, which sized the
  whole `AppShell` to its content and pinched the app into a ~490px column. The
  fix is one rule (`.app-tabs { display: block; width: 100% }`) — the AppShell
  does all the layout, so the Tabs root only has to get out of the way.
- **Mantine 9's Grid spacing prop is `gap`, not `gutter`.** The existing code was
  already right; changing it was a regression, caught by `tsc`.
- **The player must not use `preload="metadata"`, and this is load-bearing.**
  Chrome allows six connections per origin, the log SSE stream permanently holds
  one, and the generations list here is 191 rows. Metadata requests for every
  visible row queued so deep that every row sat at `0:00 / 0:00` indefinitely
  *and* the app's own 2s status poll starved behind them. The peaks decode
  already yields an exact duration, so the player takes it from there, callers
  that know a duration pass it (`durationSec` — music takes and saved voices
  both carry one), and a metadata request is now the last resort for nothing.
  Peak fetches are additionally capped at three in flight.
- **Two bugs the plan could not have predicted**, both found by inspecting the
  live canvas: `draw()` cannot be called in the promise that resolves the peaks
  (`setHasPeaks` is what renders the canvas, so `canvasRef` is still null and the
  call is a silent no-op with nothing to retry it), and the unplayed waveform
  colour must be lighter than every surface in the ramp — at 28px tall most bars
  are a few pixels, so a colour that merely *differs* from the card is not a
  colour anyone can see. Hence the separate `--app-wave` token.
- **Durations round rather than truncate.** This app's TTS history is full of
  genuine sub-second clips (measured: 0.84–0.96s), and a truncating clock labels
  a real 0.96s file `0:00`, which reads as empty rather than short.
- **Mantine's light `Alert` reads as a filled warning bar** on this ground. It is
  restyled globally to a quiet surface with a coloured spine.
- **The history list is paginated at 40 rows.** Every row is a media element plus
  a canvas; 191 at once is enough DOM and decoding to stall the tab.
- **`AppShell`'s footer spans the whole window**, which chopped the rail off at
  the dock and made the sidebar look truncated. Offset by
  `--app-shell-navbar-width` so the rail runs unbroken to the bottom.

Shipped: `theme/` (tokens, global stylesheet, component defaults),
`components/shell/` (`TopBar`, `AppNav`, `LogDock`), `components/ui/`
(`AudioPlayer`, `SectionCard`, `StatusDot`, `Meta`, `EmptyState`), `lib/peaks.ts`,
`lib/logStore.ts`, `ModelRegistrationPopover`, the Monaco retheme, and adoption
across all eight panels. Self-hosted Inter + JetBrains Mono via
`@fontsource-variable/*`. `vite.config.ts` gained an `AUDIOCPP_API` override so
the dev server can be pointed at an already-running backend.

**Not done, deliberately:** light mode (out of scope, as below), and Monaco is
still CDN-loaded — pre-existing, and no *new* network dependency was added.

---

## Why — what is actually wrong

Not "Mantine looks bad". **There is no design layer at all.** `main.tsx:10` is
the entire theme:

```ts
const theme = createTheme({ primaryColor: "grape" });
```

Everything else is Mantine defaults on `defaultColorScheme="dark"`. The visible
consequences, in order of how much damage they do:

1. **The native `<audio controls>` element.** `OutputPlayer.tsx:82` renders one
   per history row. Eight stacked Chrome players — light-grey pills on a dark
   page — are, by pixel area, the most prominent thing in the window, and they
   belong to a different application. Nothing else on the page can look
   considered while these are on it.
2. **A hard 1140px cap on an ultrawide monitor.** `App.tsx:144` wraps everything
   in `Container size="lg"`. The window is ~2000px; the content never grows past
   ~1140 no matter how much room there is, so the app reads as a phone page
   pasted onto a monitor.
3. **One surface, one border, one radius, forever.** Every block is
   `Paper withBorder p="md" radius="md"` on `dark.7` — server controls, tab
   content and the log slab all carry identical visual weight. Nothing reads as
   primary, so the eye has nowhere to land.
4. **The checkbox wall.** `ServerControlBar.tsx:117` dumps every known model into
   a wrapping `Group` of raw checkboxes — three ragged rows, no grouping by
   task, permanently occupying the top of the fold for a control you touch once
   per session.
5. **A header that only repeats itself.** The `SERVER: RUNNING` badge
   (`App.tsx:136`) duplicates the badge 40px below it in `ServerControlBar`.
6. **Logs own the bottom third**, expanded by default, and Monaco carries its own
   palette (`lib/logLanguage.ts`), so it reads as a foreign island.
7. **No identity.** The app is called *Studio*, its logo is a waveform, and there
   is not one audio-native cue anywhere: no waveform, no level, no mono numerics.

Point 7 is the cheapest to fix, because the brand already exists.

---

## The direction — decided

**Studio console**: a near-black DAW-flavoured surface, executed with the
restraint of a modern minimal app. DAW *vocabulary* — mono numerics, waveforms,
meters, a rail — without a wall of skeuomorphic knobs.

### The palette is in the logo — verified

`frontend/src/assets/logo.png` decoded pixel-by-pixel. Two dominant hues, and
they map cleanly onto two different jobs:

| Sampled | Role |
| --- | --- |
| **`#a651de`** violet — the speech-bubble outline | **Chrome accent.** Selection, focus rings, primary buttons, the active rail item. |
| **`#ef1ac4`** magenta — the waveform bars | **Audio accent.** Playhead, waveform fill, recording, the generating state. |

The logo already says it: the *outline* is violet, the *audio* is magenta.
`primaryColor: "grape"` was groping toward this and landed flat, on one shade,
used once. The redesign makes it a system — a full 10-stop Mantine palette per
hue, with the magenta reserved strictly for things that are *live*, so that
"something is playing / recording / rendering" is legible from across the room.

### Surfaces — three tiers, not one

| Token | Use |
| --- | --- |
| `--surface-0` `#0a0a0d` | App background, the rail's outer edge |
| `--surface-1` `#121116` | Cards, panels |
| `--surface-2` `#1a1922` | Inputs, raised rows, hover |
| `--border-hairline` `rgba(255,255,255,.07)` | Default separation |
| `--border-strong` `rgba(255,255,255,.14)` | Focused / active |

Separation comes from the **colour step**, not from a border on everything.
Borders drop to hairlines and most cards lose them entirely — that alone removes
most of the visual noise in the screenshot.

### Type

- **Inter Variable** for UI, **JetBrains Mono Variable** for anything that is a
  number, an id, a path, a duration or a log line.
- Both via `@fontsource-variable/*` npm packages, **bundled by Vite, never a
  CDN** — the desktop entrypoint is a local pywebview window and must render
  identically offline.
- Section headers become the small-caps micro-label pattern (`11px`, `600`,
  `letter-spacing: .08em`, dimmed) instead of `<Title order={5}>`, which is what
  makes a dense console legible without shouting.

Mono numerics matter more than they sound: `20.6 GB`, `22.3s`, `45 KB`,
`0:00 / 0:04`, `pid 25312` and the realtime factors in `MusicTakes` all stop
jittering as they update, and columns line up.

---

## Architecture — a theme layer, not a rewrite

The rule for this whole plan: **~70% of the visual change must land in the theme
and a handful of new shared components**, so that `CallPanel.tsx` (966 lines) and
`MusicPanel.tsx` (747 lines) are edited for *layout* only, never for logic.

Mantine 9 gives three seams, all used:

- `createTheme({ components: { Button: Button.extend({ defaultProps, classNames }) } })`
  — restyle every `Button`, `Paper`, `Card`, `TextInput`, `Select`, `Textarea`,
  `Badge`, `Tabs` once, globally.
- `cssVariablesResolver` — publish the surface/border tokens as CSS variables so
  plain CSS modules and the Monaco theme can read the same values.
- Custom palettes via `colors: { violet: [...], magenta: [...] }` +
  `primaryColor`, so `c="dimmed"`, `color="red"` etc. keep working everywhere
  untouched.

### The nav rail must not remount anything

`CLAUDE.md` records the bug this would otherwise reintroduce: Mantine `Tabs`
defaults to `keepMountedMode: "activity"`, and React 19's `<Activity>` re-runs
effects on hide — which is why `callSession.ts` owns the engine at module scope
and why an unmount cleanup once hung up the call every time you glanced at
another tab.

So the rail **keeps Mantine `Tabs` as the mount machine** and only moves and
restyles its parts:

```tsx
<Tabs value={tab} onChange={setTab} orientation="vertical">
  <AppShell navbar={{ width: 220, breakpoint: "sm" }}>
    <AppShell.Navbar><Tabs.List /* rendered as the rail */ /></AppShell.Navbar>
    <AppShell.Main>{/* Tabs.Panel ×8, unchanged */}</AppShell.Main>
  </AppShell>
</Tabs>
```

`Tabs` is context — the `List` and the `Panel`s do not need to be siblings.
Mount semantics are therefore **bit-identical to today**, and no panel's state,
effects, or engine lifecycle changes. A hand-rolled rail with conditional
rendering would unmount every panel on every navigation; it is not an option.

---

## Phases

Each phase is independently shippable — stop after any one and the app is
coherent. After every phase: `cd frontend; npx tsc --noEmit`, then
`.\scripts\build.bat`, then launch and look at it.

### Phase 0 — Tokens and theme

New: `src/theme/tokens.css`, `src/theme/global.css`, `src/theme/theme.ts`.

- Both 10-stop brand palettes, generated from the two sampled hues.
- Surface/border/shadow/radius CSS variables via `cssVariablesResolver`.
- Self-hosted Inter + JetBrains Mono; `fontFamilyMonospace` pointed at the latter.
- Global component defaults: `radius="lg"` on cards and inputs, `withBorder` off
  by default, hairline borders, tighter heading tracking, a violet focus ring
  that is visible on `--surface-1` (the current default is nearly invisible).
- `main.tsx` swaps the one-line theme for this.

**Acceptance:** every existing screen already looks different and nothing is
broken — no panel file has been touched yet. This is the phase that proves the
theme layer is doing the work.

### Phase 1 — Shell: top bar, rail, log dock

Touches `App.tsx` plus three new components.

- **`TopBar`** — logo, wordmark, and the server state as a *dot + label* with
  host/pid/device as mono meta, plus `VramMenu`. The duplicate badge dies here.
- **`AppNav`** — the vertical rail: 8 items, icon + label, violet active
  indicator, collapsible to icons-only (persisted to `localStorage`), grouped
  `Generate` (TTS, Music) / `Listen` (Transcribe, Call) / `Manage` (Voices,
  Library, OCR, Telemetry). Rendered as `Tabs.List` per the rule above.
- **`LogDock`** — logs move to a bottom dock, **collapsed by default**, whose
  collapsed bar is itself a readout: line count, and the most recent line
  colour-coded by level. Expanding gives a resizable Monaco pane.
  `keepMounted={false}` stays — the comment at `App.tsx:218` explains exactly why
  (Monaco disposes itself under `<Activity>`), and the SSE backlog replays on
  reconnect.
- Content goes fluid: `Container` out, `max-width: 1600px` with responsive
  gutters in.

**Acceptance:** on a 2000px window the content uses the width; logs no longer
own the fold; switching tabs during an active call does not interrupt it.

### Phase 2 — The audio player

The highest-value component in the plan. New: `src/components/ui/AudioPlayer.tsx`,
`src/components/ui/AudioRow.tsx`, `src/lib/peaks.ts`.

- One circular play/pause control, a seek bar with a magenta playhead and a
  buffered track, mono `0:04 / 0:12`, volume behind a hover popover, and download
  / overflow actions in the row — replacing every native `<audio controls>`.
- **Real peaks, not decorative ones.** `peaks.ts` fetches and
  `decodeAudioData`s a clip through one shared lazily-created `AudioContext`,
  reduces it to ~200 min/max bars, and caches by URL in a `Map`. A fake waveform
  that does not match its audio is worse than none.
- **Guarded by size and visibility.** Decoding is triggered by an
  `IntersectionObserver` so an off-screen history row costs nothing, and skipped
  entirely above a threshold (~4 MB) — a 3-minute stereo music take is ~33 MB
  (`CLAUDE.md`, verified) and must fall back to the plain seek bar rather than
  decode 33 MB to draw 200 bars.
- **One `<audio>` at a time.** Playing a row stops the previous one; today eight
  independent native players can all play at once.
- Adopted immediately in `OutputPlayer` (latest + history) and `MusicTakes`.

**Acceptance:** no `<audio controls>` remains in the tree
(`grep -r "audio controls" src/` is empty); the history list looks like one
component instead of eight embedded browsers.

### Phase 3 — Server cockpit

Touches `ServerControlBar.tsx`; new `ModelRegistrationPopover.tsx`.

- The bar becomes one dense strip: state dot, mono meta chips
  (`127.0.0.1:9090 · device 0 · pid 25312 · 10 slots`), Start/Stop/Rescan.
- **The checkbox wall moves into a popover** summarised as `10 of 10 models`,
  with models grouped by task (`tts` / `asr` / `gen`), a filter field, and
  select-all per group. The existing semantics survive verbatim: disabled while
  running or starting, the "not registered in the running server" warning
  (`ServerControlBar.tsx:133`), and the unknown-folder count.
- Registered-and-loaded models get a magenta dot, so the strip doubles as a
  readout of what actually holds VRAM.

**Acceptance:** the top of the fold is one line tall instead of five; every
warning that exists today still appears.

### Phase 4 — Panel adoption

New: `SectionCard`, `StatusDot`, `MetaChip`, `EmptyState` under
`src/components/ui/`. Then, panel by panel, in this order — front door first:

1. `TtsPanel` — establishes the two-column *work / output* layout others copy.
2. `AsrPanel` — dropzone and `MicRecorder` restyle; the karaoke transcript gets
   the magenta active-word treatment.
3. `MusicPanel` + `MusicTakes` — four zones become four `SectionCard`s; take rows
   get the new player and mono cost readouts. **Do not** replace the plain `Box`
   scroller in `MusicTakes` with `ScrollArea.Autosize` — `CLAUDE.md` records that
   it measured 579px of content inside a 440px viewport and broke the ellipsis.
4. `CallPanel` — the orb becomes the centrepiece: concentric magenta rings driven
   by the real mic level and playback state, with distinct visuals for
   `listening` / `thinking` / `preparing` / `speaking`. **Layout only** — the
   `useSyncExternalStore` subscription to `callSession` is not touched.
5. `VoicesPanel`, `LibraryPanel`, `OcrPanel`, `TelemetryPanel` — cards, mono
   numerics, and real empty states.
6. **Empty states everywhere the server is stopped.** Today a stopped server just
   yields greyed-out buttons; each panel gets one line explaining what to do.

**Acceptance:** no panel still renders a bare `Paper withBorder p="md"`; every
panel has a defined stopped-server state.

### Phase 5 — Polish

- **Retheme Monaco** from the same CSS variables (`lib/logLanguage.ts`,
  `LogPanel.css`) so the log stops being a foreign island. The level bars keep
  their semantic colours — they are the one place raw hue carries meaning.
- Motion: 120–180ms `ease-out` on hover/press, a magenta shimmer on the generate
  button while rendering instead of a bare spinner, all behind
  `prefers-reduced-motion`.
- Keyboard: visible focus rings throughout, `Ctrl+1..8` for the rail,
  `Ctrl+\`` to toggle the log dock.
- A narrow-window pass (rail auto-collapses under `sm`), since the same page is
  occasionally opened from a phone through the tunnel.

---

## Rules this redesign must not break

Each of these is recorded in `CLAUDE.md` as something that was already paid for
once:

- **`callSession` stays at module scope** and the rail must not unmount panels.
- **`Collapse keepMounted={false}`** around `LogPanel` stays — Monaco disposes
  itself under React 19's `<Activity>` otherwise.
- **`MusicTakes` keeps its plain `Box` scroller**, not `ScrollArea.Autosize`.
- **`VoicePicker` gains no upload / record / preview / delete.** Voices are
  managed in exactly one place, deliberately.
- **`lib/chunk.ts` is not touched** — it is fixture-locked to the Android
  `Chunker`.
- Fonts are bundled, not fetched. (Monaco itself is still CDN-loaded today; that
  is pre-existing and out of scope, but no *new* network dependency is added.)

## Out of scope

Light mode (this is a dark tool on a dark desktop; a second palette doubles every
phase for no current user), the Android app, any backend change, and replacing
Mantine.

## Cost

Phases 0–2 are the bulk of the visible win and touch few files. Phase 4 is the
long tail — eight panels, mostly mechanical once the primitives exist. `tsc
--noEmit` after each; `npm test` only matters if `chunk.ts` is touched, which it
must not be.
