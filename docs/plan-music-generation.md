# Plan — Music generation in Studio (ACE-Step 1.5 first)

Add a **Music** tab to audio.cpp Studio: a prompt field enhanced by a llama.cpp
model, a llama model selector, a system prompt that switches with the selected
*music* model, and the parameter set ACE-Step actually rewards. Android follows
later, over the same `/api/music/*` endpoints.

Everything below marked **verified** was read out of the source in this repo or
in `E:\LLM\audio\audio.cpp`, not assumed.

---

## Status — phases 0–3 and 6 shipped, 5 dropped, 4 open

Built and verified on 2026-08-14. What changed against the plan below, and why:

- **The base DiT was downloaded, so no trimmed spec override was needed.** With
  `acestep-v15-base/` present, the eager file check in §1(b) is satisfied and the
  `spec_trim` machinery was never built. If the base variant is ever removed, it
  comes back as a requirement.
- **`busy_timeout_ms` needed no change.** The server default is 300 000 ms and a
  take renders in seconds, not minutes.
- **Spec discovery needed no change.** `process.py` already runs the audio server
  from the audio.cpp checkout root, which is where `model_specs/ace_step.json`
  is found.
- **Measured on this machine (RTX 5090, turbo, 8 steps), output 48 kHz stereo:**
  30 s of music in 9 s cold / 180 s in 17 s via the CLI; 45 s in 9 s cold and
  **3 s warm** through Studio. Generation is fast enough that multi-take is
  comfortable and the timeouts below are pure slack.
- **Variants are registered per DiT**, not switched per request:
  `selection_from_request` reads a `ModelLoadRequest`. `Ace-Step1.5@turbo` and
  `@base` are two lazy models from one directory, the same shape as a pocket-tts
  language pack — so `serverjson.py` needed no changes at all.

Shipped: `scripts/convert_ace_step_silence_latent.py`, `catalog.ModelVariant`,
`backend/music.py`, `backend/music_prompt.py`, `proxy.music`, `[music]` and
`[[llama.music_prompt]]` config, `GET /api/music/models|prompts|takes`,
`POST /api/music/enhance|generate`, `MusicPanel` + `MusicTakes`, and
`tests/test_music.py` (16 tests over the silent failure modes: option-key names,
seed rules, JSON recovery).

**Enhancement verified** against gemma-4-26b: a one-line idea came back in 11 s
as a caption, structured lyrics (one modifier per tag, ~6 syllables a line, CAPS
for intensity), and bpm/key/time-signature/duration as separate fields, with
tempo and key correctly kept *out* of the caption.

Added afterwards, both driven by using it:

- **A global Free VRAM control in the header** (`backend/vram.py`, `VramMenu`).
  Both inference servers hold models by design and neither knows about the other,
  so *free the audio models → write a prompt with a big chat model → free that →
  generate* had no single place to act. It lists only servers actually holding
  something, so it doubles as a readout.
- **Takes now show what they cost** — variant, steps, wall time, realtime factor
  — plus a copy-the-recipe button and an expander for the full caption and lyrics.

**Found while building it:** audio.cpp's `LoadedModel::unload()`
(`app/server/runtime.cpp`) frees the session and the model but never clears the
model's `loaded` flag, so `/v1/models` reports it loaded forever after
`/v1/tasks/unload_models` or `unload_all_models`. Its `POST /v1/models/unload`
path *does* clear it, so the fix is one line in `unload()`. Worth an upstream PR;
until then `vram.py` intersects the flag with Studio's own warm set.

### Phase 6 — Android, shipped 2026-08-14

The phone needed a **free tab slot** first: Material 3 tops out at five, and the
app already had them. **Read was folded into Library** — capture and the shelf it
lands on were two peers describing one thing, so the reader is now pushed over
the library list, reached by opening a saved reading or by a camera FAB, with the
deck in progress shown as a card of its own so an unsaved set of pages is never
out of reach. That freed the slot Music took.

Shipped in `audiocpp-android`: the music half of `data/Api` (including the
generate SSE, read exactly like `/api/chat`), `music/MusicController`,
`ui/MusicScreen`, `music_model`/`music_chat_model` settings, and a **MUSIC mode
in `PlaybackEngine`** so a take gets the mini-player and lock-screen controls for
free. A take is *streamed* rather than downloaded (~33 MB for three minutes),
which is why the Access token also had to be attached to ExoPlayer's HTTP data
source, under the same HTTPS-only rule `Api.authorize` follows.

Deliberately **not** carried over: the system-prompt editor. The profile's text
stays on the PC next to the model that uses it, and the phone omits
`systemPrompt` from `/api/music/enhance` so the backend always uses the live one.

**Fixed while porting:** `music_prompt._coerce` returned the model's own
`timesignature` key while a spec uses `timeSignature`, and `fields` is spread
straight into the caller's draft — so an enhanced time signature was silently
dropped on *both* clients. `_coerce` now renames it (`tests/test_music.py`).

### Phase 5 — MiniMax, closed 2026-08-14: wrong model, twice over

Investigated and **dropped**. Two separate findings, both checked in the source
rather than assumed:

1. **MiniMax *Music 3* and MiniMax *H3* are different models.** The Music3
   caption-rewriter skill describes a song model taking `instructions` (a
   structured caption) plus `input` (lyrics with section markers). audio.cpp's
   `minimax_h3` family is **FL2VA**: "text-to-audio/video generation through the
   official T2VA pipeline: Qwen3-VL text conditioning, joint audio/video DiT
   denoising". Upstream `0xShug0/audio.cpp` (checked at 04ba437, the same commit
   this fork is on) ships `model_specs/minimax_h3.json` and nothing for Music3,
   so there is no Music3 support to build on — that would be an upstream port.
2. **H3 is a poor fit for this tab even so.** Its own spec declares
   `"music": ["instrumental", "style_control"]`, and the word "lyrics" does not
   appear in it at all. Audio length is set by *video* frames at 24 fps (default
   124 ≈ 5 s; upstream's own benchmark used 481 ≈ 20 s). Measured upstream on a
   5090: 1.5–2.7× realtime at **16.5 GB peak VRAM**, against ACE-Step turbo's
   5–17× realtime for three-minute songs with vocals at ~4 GB. The package is a
   plain download (`audio-cpp/audio.cpp-gguf`, folder `MiniMax-H3-Q4-GGUF`) but
   **32.5 GB** for the required files.

Putting H3 behind this tab would inherit a caption + lyrics + BPM + key form in
which three of the four do nothing. **The family plumbing stays** — profiles are
bound to a family and `CatalogEntry` already carries per-family routes and
variants — but the second family that exercises it is not H3. A MiniMax-Music3
port upstream is the thing to watch for.

**Open:** phase 4 only (audio-conditioned routes — the backend accepts every
field, neither UI offers them yet).

Everything from here down is the original plan, kept as the reasoning record.

---

## 0. What audio.cpp already gives us

**Verified.** ACE-Step 1.5 is a first-class family — `src/models/ace_step/`,
`docs/models/ace_step.md`, `model_specs/ace_step.json`.

| Fact | Value |
|---|---|
| Family | `ace_step` |
| Task string in `server.json` | `"gen"` (`parse_voice_task_kind`, `src/framework/runtime/session.cpp:171`) |
| Routes | `text2music`, `complete`, `lego`, `extract`, `cover`, `cover-nofsq`, `repaint` |
| DiT variants | `acestep-v15-turbo` (default), `acestep-v15-base` |
| Server endpoint | `POST /v1/tasks/run` — the generic framework route |
| Response | JSON with `audio` = **base64 WAV** + `sample_rate`, `channels`, `timing` (`task_result_json`, `app/server/runtime.cpp:570`) |

There is **no** `/v1/audio/music` endpoint and no streaming for `gen`. One
request in, one finished WAV out. That shapes the whole UI: this is a job with a
progress log, not a player that starts early.

### Request shape

`/v1/tasks/run` takes `{"model": "<id>", "request": { … }}`, where the request
object uses the CLI's JSON field names (`app/cli/request.cpp`). Verified fields
relevant to ACE-Step:

- Top level: `text`, `lyrics`, `language`, `task_route`, `duration_seconds`,
  `num_inference_steps`, `guidance_scale`, `seed`, `track_name`,
  `repaint_start`, `repaint_end`, `repaint_mode`, `repaint_strength`, `audio`
  (server-local WAV path), `options`
- `options` is a flat string map = every `--request-option`: `bpm`, `keyscale`,
  `timesignature`, `negative_prompt`, `lm_temperature`, `lm_cfg_scale`,
  `lm_top_k`, `lm_top_p`, `lm_repetition_penalty`, `sampler_mode`,
  `retake_seed`, `retake_variance`, `audio_cover_strength`,
  `cover_noise_strength`, `complete_track_classes`, `audio_codes`

### Quality caveat from upstream's own test matrix

`docs/gguf.md` grades `ace_step`: **safetensors = Pass**, bf16 GGUF = *Pass
(drift)*, q8_0 GGUF = **No (planner sampling can fail)**. So: use the
safetensors checkpoints you already have. Do not download the q8_0 package.

---

## 1. Model install — copy, don't download

`E:\LLM\ACE-Step-1.5\checkpoints` **is** the `ACE-Step/Ace-Step1.5` snapshot
that audio.cpp's installer pulls (`tools/model_manager_deprecated.py:199`). The
layout already matches `model_specs/ace_step.json`'s safetensors source.

Copy into `E:\LLM\audio\audio.cpp\models\Ace-Step1.5\` (the installer's
`target_directory`, ≈ 9.5 GB):

| Copy | Skip |
|---|---|
| `config.json` | `.cache/`, `.gitattributes` |
| `acestep-v15-turbo/` | `acestep-v15-xl-turbo/`, `acestep-v15-xl-sft/` — **XL is not supported**; the loader accepts only `acestep-v15-turbo` and `acestep-v15-base` (`src/models/ace_step/assets.cpp:120`) |
| `acestep-5Hz-lm-1.7B/` | `acestep-5Hz-lm-4B/` — the spec hardcodes the 1.7B planner path |
| `Qwen3-Embedding-0.6B/` | |
| `vae/` | |

`robocopy /E /XD .cache` is the right tool; a plain copy is safer than a
junction, since you may later clean up the original tree.

### Two things must be fixed after copying

**a) `silence_latent.pt` → `silence_latent.safetensors`.** The spec wants
safetensors; the HF snapshot ships a `.pt`. audio.cpp's own converter is
`convert_ace_step_silence_latent` (`tools/model_manager_deprecated.py:1929`) —
a four-line torch load + `save_file`. Run it once against
`models/Ace-Step1.5/acestep-v15-turbo/` with audio.cpp's venv (CPU torch and
`safetensors` are already installed there).

**b) The missing `acestep-v15-base/` blocks loading, even for turbo.**
`add_resource_map` / `add_tensor_map`
(`src/framework/model_spec/package.cpp:280,312`) check **every** file in the
spec eagerly and throw `missing model package file 'dit_base_config'` before
any lazy per-variant access happens. The spec lists `dit_base_config`,
`dit_base_weights`, `dit_base_silence_latent`, and you only have turbo.

Two ways out:

1. **Trimmed spec override (recommended, 0 bytes downloaded).** The server
   config accepts `model_spec_override` per model entry (`app/server/config.cpp`).
   Studio generates `backend/generated/model_specs/ace_step.json` at
   server-start time — a copy of audio.cpp's spec with the three `dit_base_*`
   entries deleted — and points the model entry at it. Self-repairing, and it
   survives an audio.cpp update.
2. **Download `ACE-Step/acestep-v15-base`.** Also unlocks the base DiT, which is
   the variant where `guidance_scale` actually does something (upstream's
   tutorial: *"Base model only"*). ~2.4 TB free on E:, so this is affordable —
   just not needed to start.

Recommendation: ship (1), and register a second lazy model entry
`ace-step-base` (same directory, `load_options: {ace_step.dit_model_path:
acestep-v15-base}`) only once (2) has been done. Lazy registration means an
unused variant costs nothing.

### Phase-0 acceptance

Before touching any Studio code, prove the model runs:

```
audiocpp_cli --task gen --family ace_step --model models/Ace-Step1.5 --backend cuda \
  --task-route text2music --text "cinematic synth pop with clear vocals" \
  --lyrics "[Verse]\nWe rise with the morning light" --duration-seconds 30 \
  --model-spec-override <trimmed spec dir> --out song.wav
```

Record the wall time for 30 s and 120 s of audio at 8 steps — every timeout
below should be set from that number, not guessed.

---

## 2. audio.cpp server wiring

`serverjson.py` already writes everything needed; the gaps are small.

- `catalog.py`: `Task` becomes `Literal["tts", "asr", "gen"]`, plus a matcher
  `_eq("Ace-Step1.5") → CatalogEntry(family="ace_step", task="gen", …)`.
- New `CatalogEntry` fields (they generalise to MiniMax-H3 later):
  - `music_routes: tuple[str, ...]` — what the Music tab offers
  - `dit_variants: tuple[str, ...]`
  - `spec_trim: tuple[str, ...]` — resource ids to delete when generating a
    spec override (`("dit_base_config", "dit_base_weights",
    "dit_base_silence_latent")`)
- `serverjson.py`: when `spec_trim` is set, write the trimmed spec and emit
  `"model_spec_override": <path>` on that model entry. `mode` stays
  `"offline"`; `lazy: true` as everywhere else.
- Raise `busy_timeout_ms` for gen models. The server serialises requests per
  model, and a music request holds the lock for a minute or more — the default
  will 503 the second click.

Everything that filters models by task must learn about `"gen"`:
`/api/server/start` already keeps anything with `family` **and** `task`, so gen
models get registered for free — but the **TTS and ASR model pickers must
exclude them**, or a music model shows up as a voice.

---

## 3. Studio backend

Three new pieces, each a sibling of something that already exists.

### `proxy.music(model, request) -> dict` (in `proxy.py`)

`POST /v1/tasks/run`, decode the base64 `audio`, return WAV bytes + timing.
Same logging shape as `proxy.speech`. Its own timeout from
`[music].timeout_sec` (start at 1800 — a 4-minute song at high steps is a long
single request, same reasoning as `media.asr_timeout_sec`).

**No run-away retry.** `proxy.speech`'s retry exists because AR TTS models miss
their EOC token and re-roll cheaply; diffusion has no such failure and a retry
would cost another full minute.

### `music.py` — the enhancement sibling of `ocr.py` / `chat.py`

Non-streaming `/v1/chat/completions` against the same llama.cpp server, with
per-family system-prompt profiles (see §6). Carries the two lessons already
pinned in `ocr.py`: retry once without `chat_template_kwargs` on rejection, and
guard the "only `reasoning_content`, empty `content`" case.

### Routes in `main.py`

| Route | Does |
|---|---|
| `GET /api/music/models` | Installed `task == "gen"` models + routes + variants |
| `GET /api/music/prompts?family=` | Enhancement profiles with their effective system prompt (mirrors `GET /api/ocr/models`) |
| `POST /api/music/enhance` | idea + family + profile + llama model → structured fields |
| `POST /api/music/generate` | **SSE**: one `take` event per rendered take, then `done` |
| `GET /api/music/takes` | List saved takes from their sidecars |

`/api/music/generate` is SSE rather than a plain POST for one reason: multiple
takes. A single request that renders four takes and answers after four minutes
is indistinguishable from a hang, and throws away the first three takes if the
fourth fails. SSE reuses the pattern `/api/chat` already established, and the
log panel carries the per-step detail underneath.

### Output store: WAV + sidecar

Each take writes `generated/<name>.wav` **and** `generated/<name>.music.json`
holding the complete upstream request (prompt, lyrics, every parameter, the
resolved seed, the model id, and the raw idea + enhancement profile it came
from). Without the sidecar a good take is unreproducible — the seed alone is
useless once the caption has been edited. With it, "Reproduce" and "Vary this"
are two buttons over data already on disk. `metrics.record(kind="music")` per
take feeds the Telemetry tab.

---

## 4. Studio frontend

New `components/MusicPanel.tsx`, a **Music** tab in `App.tsx`, shapes in
`types.ts`, calls in `api.ts`. Four zones top to bottom:

1. **Idea + enhance** — a short free-text field ("what do you want to hear?"),
   the llama model selector, the enhancement profile selector, an
   *Include lyrics* toggle, and **Enhance**. Enhancing fills the fields below
   and keeps the previous values one Undo away — an enhancement that silently
   overwrites hand-written lyrics is a data-loss bug, not a feature.
2. **Caption + lyrics** — the two fields the model actually consumes, always
   editable by hand (enhancement is optional throughout). Lyrics get
   structure-tag chips (`[Verse]`, `[Chorus]`, `[Bridge]`, `[Instrumental]`, …)
   and an **Instrumental** toggle that sets the lyrics to `[Instrumental]`.
3. **Parameters** — §5, in a `ParamsAccordion`-style disclosure: the four
   headline controls visible, metadata and planner-LM controls folded away.
4. **Takes** — rendered results with `OutputPlayer`, each showing its seed and
   duration, with **Reproduce** and **Vary** (retake seed) buttons.

The llama model list comes from `chat.list_models()` — the same discovery the
Call tab uses, for the same reason: llama-swap already knows the models and a
second hand-written list only goes stale. `loaded` is already in that payload,
so the picker can warn that a cold model costs a swap before the first token.

---

## 5. Parameters worth having

Grouped by how often they are touched. Defaults are audio.cpp's, and the
guidance is upstream's own tutorial.

### Always visible

| Control | Field | Default | Why it earns the space |
|---|---|---|---|
| Duration | `duration_seconds` | `-1` (planner decides) | The one thing every user sets. Tutorial: 30–60 s and 2–4 min are the stable bands; very long drifts into repetition. |
| Seed | `seed` | random | **The single most valuable control here.** Upstream: fix the seed when tuning anything else, or you cannot tell a parameter change from a different roll. Needs a visible value, a dice button, and a lock. |
| Steps | `num_inference_steps` | `8` (turbo) | The quality/time dial. Turbo 4–16; base wants ~30+. |
| Takes | *(client-side loop)* | 1 | Upstream recommends batching 2/4/8 and screening. audio.cpp has no `batch_size` for `ace_step`, so this is N sequential requests with N seeds — which is also why `/api/music/generate` streams. |

### Metadata (blank = the planner LM infers it)

`bpm` · `keyscale` · `timesignature` · `language` · `negative_prompt`

All optional overrides, all in `options` except `language`. Upstream is explicit
that **tempo and key do not belong in the caption** — they belong here — so the
UI should carry that as helper text, and the enhancement system prompt must say
the same thing (§6). Ranges worth hinting: bpm 30–300 (60–180 reliable),
timesignature 4/4 · 3/4 · 6/8.

### Diffusion (folded)

| Control | Field | Default | Note |
|---|---|---|---|
| Guidance scale | `guidance_scale` | `1.0` | **Turbo largely ignores this** (tutorial: "Base model only"). Show it disabled with that reason on turbo rather than offering a dial that does nothing. |
| Sampler | `options.sampler_mode` | `euler` | `euler` \| `heun` |
| Retake seed / variance | `options.retake_seed`, `retake_variance` | — | "Vary this take": same take, nudged. Drives the **Vary** button. |

### Planner LM (folded, advanced)

`lm_temperature` 0.85 · `lm_cfg_scale` 2.0 · `lm_top_k` 0 · `lm_top_p` 0.9 ·
`lm_repetition_penalty` 1.0

This is ACE-Step's *internal* LM that infers metadata and semantic codes — not
the llama.cpp model doing prompt enhancement. The UI must not let those two be
confused; label this group "ACE-Step planner" and keep it far from the model
selector at the top.

### Deliberately not exposed

`flow_edit_morph` (documented as parsed but not implemented) and `dcw_enabled`
(experimental). `audio_codes` too — it bypasses the planner and belongs to a
workflow the Music tab does not have.

### Route-dependent (phase 4)

`task_route` selector, source-audio picker, and then per route: `repaint_start`
/ `repaint_end` / `repaint_mode` / `repaint_strength`, `track_name` (lego,
extract), `options.complete_track_classes`, `options.audio_cover_strength`,
`options.cover_noise_strength`. The source-audio field reuses the existing
upload path — `uploads/` already stores a server-local WAV and hands its
absolute path upstream, exactly as `voice_ref` does.

---

## 6. Prompt enhancement

### Config shape

Follow the OCR-profile pattern exactly — it is already proven here, and it is
what lets the system prompt switch with the *music* model:

```toml
[[llama.music_prompt]]
id            = "ace-step-default"
label         = "ACE-Step 1.5"
family        = "ace_step"      # ← the switch: matched against the music model's family
default       = true
model         = ""              # optional preferred llama model; blank = user's pick
temperature   = 0.8
max_tokens    = 1200
send_thinking_kwarg = true
enable_thinking     = false
system_prompt = """…"""
```

`GET /api/music/prompts?family=ace_step` returns these with their effective
prompt, so the panel can prefill an editable box — same as the OCR test bench.
Selecting a MiniMax-H3 model later swaps the profile automatically because it
is keyed on `family`, with no client-side mapping to maintain.

### The output contract

The enhancement must return **structured fields, not a longer sentence** —
otherwise it cannot fill BPM, key, and lyrics, and the user is back to
copy-pasting. Ask for strict JSON:

```json
{"caption": "…", "lyrics": "…", "bpm": 70, "keyscale": "Am",
 "timesignature": "4/4", "language": "en", "duration_seconds": 210}
```

Parse it; on a parse failure fall back to using the whole reply as the caption
rather than erroring — a usable caption beats a red toast. `lyrics` is omitted
when *Include lyrics* is off.

### What the ACE-Step system prompt must contain

Straight from upstream's tutorial, and it is why a single generic "make this
prompt better" instruction would underperform:

- **Caption = style, emotion, instruments, timbre, era, production, vocal
  character, rhythm feel.** Multiple dimensions, specific over vague
  ("sad piano ballad with female breathy vocal", not "a sad song").
- **Never write BPM, key, or tempo into the caption** — emit them as the
  separate metadata fields.
- **Lyrics use structure tags** (`[Verse]`, `[Chorus]`, `[Bridge]`,
  `[Instrumental]`, `[Guitar Solo]`, `[Fade Out]`) with at most one modifier
  (`[Chorus - anthemic]`, never a stack of six).
- **6–10 syllables per line**, consistent within a section — the model aligns
  syllables to beats.
- CAPS for intensity, `(parentheses)` for backing vocals, blank lines between
  sections.
- **Caption and lyrics must not conflict** — instruments in the caption must
  match instrumental tags in the lyrics, emotion must match energy tags. The
  tutorial is blunt: the model is bad at resolving contradictions.
- One core metaphor per song; avoid stacked adjectives and forced rhyme.

A MiniMax-H3 profile will look nothing like this (scene/audio description, no
lyrics, no metadata) — which is the entire argument for per-family profiles
rather than one prompt with conditionals.

---

## 7. Phasing

| Phase | Scope | Done when |
|---|---|---|
| **0** | Copy checkpoints, convert `silence_latent`, trimmed spec, CLI smoke test | A WAV plays, and 30 s / 120 s render times are recorded |
| **1** | Catalog + serverjson + `proxy.music` + `POST /api/music/generate` + minimal Music tab (caption, lyrics, duration, seed, steps) | Music generated from Studio end to end |
| **2** | Full parameter set, multi-take SSE, sidecars, Reproduce/Vary, telemetry | A good take can be reproduced exactly a week later |
| **3** | `music.py`, `[[llama.music_prompt]]`, llama model selector, enhance → structured fields | A one-line idea becomes a caption + lyrics + metadata that render well |
| **4** | Audio-conditioned routes (cover, repaint, extract, complete, lego) | An uploaded track can be covered and repainted |
| **5** | MiniMax-H3 as a second `gen` family — validates that nothing is ACE-Step-shaped | Switching model switches routes, params, and system prompt |
| **6** | Android: Music screen over the same `/api/music/*` endpoints | — |

Phases 1–3 are the request. 4–6 are the payoff for keeping family-specific
knowledge in the catalog and in config profiles rather than in the panel.

---

## 8. Decisions to confirm

1. **Base DiT** — ship turbo-only with the trimmed spec (no download), or also
   pull `ACE-Step/acestep-v15-base` so `guidance_scale` becomes real? Turbo-only
   is assumed below; adding base later is a second lazy model entry and a
   catalog line.
2. **Enhancement language** — the OCR and Call prompts here are German. Is the
   music enhancement German-facing with English captions (ACE-Step's caption
   vocabulary is English), or German throughout? Assumed: German UI + German
   chat, English captions, lyrics in whatever language the idea is written in.
3. **Where takes live** — `generated/` alongside TTS output (assumed), or a
   separate `music/` store with its own retention. Songs are much larger than
   speech clips, so this matters within weeks.

---

## 9. Risks

- **Render time is unknown until phase 0.** Every timeout, the SSE cadence, and
  whether multi-take is even pleasant all hang off that measurement.
- **VRAM.** ACE-Step holds a DiT + a 1.7B planner + Qwen3-Embedding + a VAE, on
  a box that also holds Higgs (20.6 GB) and a chat model. Lazy loading means it
  is only paid on first use, but the Telemetry tab's **Free VRAM** button
  becomes the routine escape hatch. `--session-option ace_step.mem_saver=true`
  is the fallback if it does not fit; it trades rebuild time for resident VRAM.
- **The q8_0 GGUF is a trap** — upstream marks its planner sampling as failing.
  If someone later "optimises" the install by swapping in the quantised
  package, generation breaks in a way that looks like a bad prompt.
