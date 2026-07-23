# Flux 2 dev — app icon prompts for audio.cpp Studio

Goal: a square app icon that reads well small (28–32 px in the header, larger as taskbar/window
icon). Match the app's look: near-black UI with a violet/magenta (grape) accent.

## Primary prompt

> Minimalist flat vector app icon on a dark charcoal rounded square, centered composition.
> A stylized audio waveform made of vertical rounded bars of varying heights, glowing in a
> vibrant violet-to-magenta gradient, the tallest bars in the middle forming a subtle peak.
> The waveform is flanked by two thin, elegant angle brackets in muted gray, hinting at code.
> Soft neon glow around the waveform, subtle depth, clean negative space, crisp edges,
> high contrast, professional app icon design, no text, no letters, dark background
> #141416, accent colors #9c36b5 and #e64bd2.

## Variant A — speech-bubble waveform

> Flat modern app icon, dark rounded square background in near-black graphite. A rounded
> speech bubble outline drawn in a single smooth violet neon stroke; inside the bubble, a
> compact audio waveform of glowing magenta rounded bars. Minimal, geometric, perfectly
> centered, soft outer glow, subtle vignette, vector logo style, no text, ultra clean,
> icon design for a text-to-speech application.

## Variant B — waveform morphing into circuitry

> Sleek app icon, matte black rounded square. A horizontal audio waveform in a luminous
> purple-magenta gradient; on the right side the waveform lines transform into thin circuit
> traces with small nodes, symbolizing speech turning into computation. Dark futuristic
> aesthetic, gentle bloom, precise vector shapes, strong silhouette readable at small size,
> no text, centered, generous padding.

## Variant C — bold glyph (best at tiny sizes)

> Ultra minimal app icon, one bold glyph: a single continuous line that starts as a sound
> wave sine curve and ends as a closing angle bracket, drawn in a thick rounded neon
> violet stroke on a near-black rounded square, faint magenta glow, flat design, huge
> negative space, extremely simple and readable at 16 pixels, vector logo, no text.

## Suggested generation settings

- Resolution: 1024×1024 (downscale later; keep a 512 and a 64/32 px version)
- Steps: 28–50 · Guidance: 3.5–4.5
- Generate 4–8 seeds per prompt and pick; small-size readability beats detail.
- If Flux adds unwanted text/letters, append: "plain graphic only, absolutely no typography".

## Using the result in the app

1. Export/downscale to PNG (e.g. 256×256) and drop it at `frontend/src/assets/logo.png`
   (plus optionally `frontend/public/favicon.png`).
2. Ask Claude to wire it into the `AppShell.Header` in `App.tsx` and the pywebview window icon.
