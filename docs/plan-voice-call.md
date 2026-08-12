# Plan — voice call (talk to a llama.cpp model in a cloned voice)

> **Status: Studio is built and working** (§1–§3, §5 steps 1–5). Android (§4) is
> not started. Where the measurements below were guesses, they have been replaced
> with what was actually observed; §7's open questions are answered in
> **§8 — what the spikes found**, which is the part worth reading first.


A **Call** tab: pick a voice, pick a chat model, talk into the microphone, hear the
answer spoken back in that voice. Studio first, Android second — the backend and
the event vocabulary are designed once so the phone reuses both.

Scope: `audiocpp-ui` (backend + frontend) first, `audiocpp-android` after.

---

## 0. Where things stand today

| piece | status | reused how |
|---|---|---|
| TTS + cloning | `POST /api/tts` (whole WAV per request) | per-sentence synthesis |
| Streaming TTS | **exists in audiocpp_server** (`mode: "streaming"`, SSE `speech.audio.delta` / raw PCM) — Studio never uses it; `serverjson.py` registers every model `mode: "offline"` | the single biggest latency win, see §1.3 |
| ASR | `POST /api/uploads` → `POST /api/transcribe` (Qwen3-ASR-0.6B, non-streaming) | fused into one call, §2.4 |
| Streaming/live ASR | server supports it, but **no streaming ASR model is installed** (`nemotron_asr`/`voxtral_realtime` absent, no catalog matcher) and `/v1/audio/transcriptions/live` **cannot be driven from a browser** (needs full-duplex HTTP) | out of scope; client-side VAD does the endpointing instead |
| llama.cpp | `ocr.py` → `/v1/chat/completions`, non-streaming, vision only | `chat.py` is its text+streaming sibling |
| Chat models | **none configured** — `[[llama.ocr_model]]` only | new `[[llama.chat_model]]`, same shape |
| Mic capture | `MicRecorder.tsx` (MediaRecorder + Analyser level meter) | *not* reusable as-is — a call needs raw PCM and pre-roll, §3.2 |
| Chunked playback | `LibraryPanel.ReadingPlayer` (generate chunk *n+1* while *n* plays) | the mental model for the call player; the call version queues PCM streams |
| Text chunking | `lib/chunk.ts` ↔ `Chunker.kt`, batch-only | a call needs an **incremental** segmenter — new, and it lives on the backend so both clients share it |
| Model loading | lazy, and **never unloaded** ("Lazy loading does not unload models after a request") | pre-warm once per call is a permanent win |
| Per-model locking | each model id serializes its own requests (`busy_timeout_ms`) | TTS and ASR are different ids → they never block each other |

Installed models: `VoxCPM2` (clone + voice-design + **streaming-capable**),
`Higgs-Audio-v3-TTS-4B-GGUF` (clone, slow AR), `Qwen3-TTS-12Hz-1.7B-Base`,
`pocket-tts`, `Qwen3-ASR-0.6B`, `Qwen3-ForcedAligner-0.6B`.

---

## 1. Design

### 1.1 The loop

```
mic ──VAD/endpoint──▶ utterance WAV ──▶ POST /api/call/listen  ──▶ transcript
                                                                      │
                                          history + transcript ───────┘
                                                   │
                                                   ▼
                                      POST /api/chat  (SSE)
                                        ├─ reasoning deltas   → collapsed panel, never spoken
                                        ├─ text deltas        → transcript bubble, live
                                        └─ speak events       → one complete, speakable sentence
                                                   │
                                    for each speak event, in order
                                                   ▼
                                      POST /api/call/speak → chunked PCM ──▶ audio queue
```

**Who orchestrates:** the client. Three plain HTTP calls per turn, the backend
stays stateless, and every piece is independently testable with `curl`. A
backend-driven WebSocket (browser streams mic PCM up, gets events + audio down)
is the better endgame — it is the only shape that can use
`/v1/audio/transcriptions/live` — but it is a much larger build and impossible to
debug piecemeal. The event vocabulary below is deliberately the one a WebSocket
would carry, so §6's phase 3 is a transport swap, not a redesign.

### 1.2 Three UX decisions that shape everything

**Turn-taking — ship both, default hands-free.**
*Hands-free*: client-side VAD ends the turn after ~700 ms of silence. Delightful,
but with speakers the assistant's own voice re-triggers it.
*Push-to-talk*: hold the call button or hold `Space`. Never false-triggers.
Default hands-free; if the VAD fires while the assistant is speaking more than
twice in a call, surface a one-time hint offering push-to-talk or headphones.
A **text input** sits next to the button as a third path — indispensable for
debugging the chat side without talking, and for a noisy room.

**Duplex — half-duplex by default.** While the assistant speaks, the mic gate is
closed and an **Interrupt** button (and `Esc`, and click-anywhere-on-the-orb) stops
playback instantly. Full-duplex barge-in (VAD stays live during playback, speaking
over the assistant cuts it off) is a toggle labelled "works best with headphones".
`getUserMedia({echoCancellation: true})` cancels most speaker bleed in Chrome but
not all of it, and a false barge-in mid-sentence is far more annoying than
pressing a button.

**Thinking — off by default, and never spoken.** The checkbox is there because it
was asked for, but its label carries the cost: *"the model reasons first — adds
several seconds before you hear anything"*. `reasoning_content` goes to a
collapsed "thinking" disclosure, never to TTS. `ocr.py` already documents the trap
where a build returns *only* `reasoning_content` with empty `content`; `chat.py`
inherits that guard, reporting it instead of falling silent.

### 1.3 Latency, and what buys it down

Time-to-first-sound is the whole feature. Budget per turn, after warm-up:

| stage | ~cost | lever |
|---|---|---|
| VAD endpoint (silence hangover) | 700 ms | tunable 400–1000 ms; the one cost that is pure policy |
| upload + ASR (short utterance) | 0.3–0.8 s | fused endpoint saves one RTT; audio is a few hundred KB |
| LLM time-to-first-token | 0.2–1 s | pre-warmed; llama-swap must not swap here |
| first complete sentence | 0.3–1 s | **flush the first segment early** (at a clause boundary past ~40 chars) instead of waiting for the full stop |
| TTS first audio | 0.3–0.8 s streaming / 1–4 s non-streaming | **streaming TTS** (VoxCPM2), else the whole sentence renders first |

≈1.5–3 s to first sound with VoxCPM2 streaming; 3–6 s with Higgs. Measure it —
`metrics.py` already tracks × realtime per model, and §2.7 adds the per-turn
breakdown.

Four levers, all in this plan:

1. **Pre-warm on "Start call"** — one tiny request to each of the three models
   (§2.6). Lazy loading means the *first* request per model pays a full VRAM load;
   after that it is loaded for the process lifetime. Without this, turn 1 of every
   session is 10–30 s and the feature feels broken.
2. **Streaming TTS** where the model supports it (§2.5) — audio starts mid-sentence.
3. **Early first flush** in the sentence streamer (§2.3).
4. **A filler earcon.** During warm-up, synthesize one short phrase ("Moment…") in
   the selected voice and cache it for the call. If nothing has been spoken 1.5 s
   after the turn was sent, play it. Costs one extra synthesis per call and
   changes the perceived latency more than anything else on this list. Off switch
   in settings.

---

## 2. Backend (`audiocpp-ui/backend`)

### 2.1 `config.toml` — chat models + call defaults

Mirrors `[[llama.ocr_model]]` exactly, so the mechanism is already familiar.

```toml
[llama]
# ... existing host/port/timeout/ocr entries unchanged ...
default_chat_model = "gemma4-12b"

# Each [[llama.chat_model]] is one selectable conversation partner, surfaced via
# GET /api/chat/models. Same key style as [[llama.ocr_model]].
[[llama.chat_model]]
id = "gemma4-12b"
label = "Gemma 4 12B"
model = "gemma4-12b-qat-uncensored-hauhaucs-balanced-q4-k-m"
temperature = 0.7
top_p = 0.95
# Prepended to every conversation. Written for speech, not for a screen.
system_prompt = """Du bist ein Gesprächspartner in einem Sprachanruf.
Deine Antworten werden laut vorgelesen. Antworte deshalb in gesprochener Sprache:
- ganze, einfache Sätze; keine Aufzählungen, Überschriften, Tabellen oder Codeblöcke
- kein Markdown, keine Emojis, keine URLs, keine Klammerzusätze
- antworte in der Sprache, in der du angesprochen wirst"""
# Reasoning model: offer the thinking switch and send chat_template_kwargs.
supports_thinking = true
send_thinking_kwarg = true
# How many prior messages to resend (the system prompt is always kept).
context_messages = 20

# Response-length presets — a segmented control in the UI. max_tokens alone would
# truncate mid-word, so each preset also states the length in the prompt.
[[call.length]]
id = "brief"
label = "Kurz"
max_tokens = 140
instruction = "Antworte in ein bis zwei Sätzen."

[[call.length]]
id = "normal"
label = "Normal"
max_tokens = 400
instruction = "Antworte in wenigen Sätzen, höchstens einem kurzen Absatz."

[[call.length]]
id = "long"
label = "Ausführlich"
max_tokens = 1000
instruction = "Antworte so ausführlich, wie die Frage es verlangt."

[call]
default_length = "normal"
# Fallbacks when the client sends none; blank = let the client decide.
default_tts_model = "VoxCPM2"
default_asr_model = "Qwen3-ASR-0.6B"
# Silence that ends a turn, and the pre-roll kept before speech starts.
vad_hangover_ms = 700
vad_preroll_ms = 300
# Play a cached filler phrase if nothing has been spoken this long after sending.
filler_after_ms = 1500
filler_text = "Moment…"
```

`config.py` gains `llama_chat_models` / `llama_default_chat_model` /
`llama_chat_model_by_id` (copies of the OCR trio) and a `call_*` block, in the
existing property style. Both example and real `config.toml` get the new sections.

### 2.2 New `backend/speakable.py`

The model writes for a screen no matter what the system prompt says; TTS reads
asterisks out loud. Two things, both pure functions and trivially testable:

- `to_speakable(text) -> str` — strip fenced code blocks (replaced by nothing, or
  by "Codeblock übersprungen" if it was the whole answer), inline backticks,
  `**bold**` / `*italic*` / `_underscore_`, headings, blockquote markers, table
  rows; turn `- item` / `1. item` bullets into sentences; `[label](url)` → `label`;
  drop bare URLs and emoji; collapse whitespace.
- `SentenceStreamer` — incremental. `feed(delta) -> list[str]`, `finish() -> list[str]`.
  - flush on `.?!…` followed by whitespace, plus optional closing quote/bracket;
  - **first segment flushes early**: past ~40 chars, a `,` `;` `:` or `–` is a valid
    boundary. Only for the first segment of a turn — the latency is only paid once;
  - don't split after a digit (`3.` in "3. Punkt", dates) or a known abbreviation
    (`z. B.`, `usw.`, `Dr.`, `Nr.`, `ca.`);
  - hard-wrap past 400 chars (matching `chunk.ts`'s ceiling) on the last space;
  - fold a runt (< ~25 chars) into the previous segment rather than emitting a
    stutter-sized clip.

This is the third chunker in the tree, and deliberately so: `chunk.ts`/`Chunker.kt`
split a *known, complete* text for a reading; this one splits a *growing* one for
latency. Putting it on the backend means the two clients don't get a fourth and
fifth copy — they just play what `speak` events tell them to.

### 2.3 New `backend/chat.py`

`ocr.py`'s text-only, streaming sibling; same error conventions (`AudiocppError`,
the "name the process and the remedy" unreachable message — it reaches the phone).

```python
async def stream_chat(profile, messages, *, thinking, max_tokens) -> AsyncIterator[dict]
```

- builds `/v1/chat/completions` with `stream: true`, the profile's temperature /
  top_p, the resolved `max_tokens`, and `chat_template_kwargs={"enable_thinking": …}`
  **only** when `send_thinking_kwarg` is set (PaddleOCR-VL's template rejects it —
  same reason it is opt-in for OCR);
- `httpx.AsyncClient.stream("POST", …)` and parse SSE `data:` lines; `[DONE]` ends it;
- splits `delta.content` from `delta.reasoning_content` and yields
  `{"type": "text"|"reasoning", "delta": …}`;
- feeds every `content` delta through `SentenceStreamer` and yields
  `{"type": "speak", "index": n, "text": …}` for each completed segment;
- on `finish_reason == "length"` yields `{"type": "truncated"}` so the UI can say
  "cut off — try a longer response length" rather than trailing off;
- guard, inherited from `ocr.py`: content empty but `reasoning_content` fat →
  a clear error naming `enable_thinking`, not silence;
- `finally`: flush `SentenceStreamer.finish()`, emit `{"type": "done", "text", "seconds", "tokens"}`,
  `metrics.record(profile_id, "chat", ms, throughput=tok_s, unit="tok/s")`.

Cancellation: the client aborting the fetch closes the connection; exiting the
`stream()` context tears down the upstream request and llama.cpp stops generating.
**Verify this actually stops generation** (§7) — if it does not, a barge-in leaves
the GPU busy for the rest of the answer.

### 2.4 `POST /api/call/listen` — one round trip, mic → text

Multipart WAV in, `{"text", "seconds"}` out. ~25 lines: reuse `_spool` into
`uploads/` (a turn is a few seconds of 16 kHz mono — small, and the retention prune
already covers it), then the existing `proxy.transcribe`. Saves one RTT and one
`fetch` per turn versus `POST /api/uploads` + `POST /api/transcribe`; over the
Cloudflare tunnel from the phone that RTT is not free.

Empty or whitespace-only transcript → `{"text": ""}` with HTTP 200. The client
treats that as "didn't catch that", flashes the hint, and does **not** spend a turn.

### 2.5 `POST /api/call/speak` — one sentence, streamed as PCM

JSON `{model, text, voiceId?, savedVoiceId?, uploadId?, referenceText?, language?}`
— the same voice-resolution code path as `/api/tts`, factored into a helper both
call (extract `_build_speech_request(body)` from `api_tts`). Response:
`Content-Type: audio/pcm`, chunked, with `X-Sample-Rate`, `X-Channels`,
`X-Sample-Format: s16le`.

Two upstream paths behind **one** client-facing shape — this is the point:

- model has a streaming registration → proxy `/v1/audio/speech` with
  `{"stream_format": "audio", "response_format": "pcm"}` straight through, chunk
  by chunk. (VoxCPM2 additionally needs `options.retry_badcase = false`; the
  server README is explicit that retrying is offline-only behaviour.)
- otherwise → the existing `proxy.speech` renders a WAV, strip the 44-byte header,
  send the PCM in one body.

So Higgs and VoxCPM2 look identical to the player; only the time-to-first-byte
differs. Raw PCM rather than base64 SSE: no 33 % bandwidth tax over Wi-Fi, and on
Android it feeds `AudioTrack` directly.

The run-away retry in `proxy.speech` (`_RUNAWAY_MARKERS`) only protects the
non-streaming path. A stream that dies mid-sentence cannot be retried
transparently — bytes are already playing. Emit the failure, let the client skip
to the next segment, and log it.

### 2.6 `POST /api/call/warmup`

`{chatModel, ttsModel, asrModel, voice…}` → warms all three in parallel and
returns `{chat_ms, tts_ms, asr_ms, filler: <base64 or an id>}`:

- chat: `max_tokens: 1` (also forces the llama-swap swap **before** the call);
- tts: synthesize `[call].filler_text` in the selected voice — the load *and* the
  filler clip in one request;
- asr: transcribe ~200 ms of silence.

Called by the client on **Start call**, behind a "Warming up…" state with per-model
ticks. This is where a 30 s cold start becomes visible and expected instead of
looking like a hang.

### 2.7 Other backend touches

- `GET /api/chat/models` → `{models: [{id, label, supportsThinking, systemPrompt}], default}`
  and `GET /api/call/config` → length presets + VAD/filler defaults, so the phone
  and Studio don't hardcode them. (Mirrors `/api/ocr/models`.)
- `main.py`: register the new routes **before** the catch-all SPA route, as always.
  `AccessLogMiddleware` is pure-ASGI so it will not buffer the chat SSE — the same
  property the log stream depends on.
- `metrics.py`: nothing structural; `record(kind="chat")` fits the existing store.
  Add a per-turn log line — `log_bus.emit("info", "call turn · asr 420ms · ttft 310ms · first audio 980ms · 47 tok")` —
  which is enough to tune the whole pipeline from the log panel.
- `serverjson.py`: if §7's spike says dual registration is needed, emit a second
  entry `"<id>@stream"` with `"mode": "streaming"` for catalog entries flagged
  `streaming=True` (VoxCPM2 today), gated on `[call].streaming_tts`. `@` already
  means "variant" here (`pocket-tts@english`), and `lookup_catalog` splits on the
  first `@`, so it fits.
- `catalog.py`: add `streaming: bool = False` to `CatalogEntry`, set on VoxCPM2.
  `models.py` surfaces it so the UI can badge "streaming — fastest for calls".

---

## 3. Studio frontend (`audiocpp-ui/frontend/src`)

### 3.1 New tab

`App.tsx`: a **Call** tab (`IconPhone`) between Transcribe and Saved Voices.
`CallPanel.tsx` gets the same `models` / `registeredIds` / `serverRunning` props
every other panel takes.

### 3.2 New `lib/vad.ts` — continuous capture with pre-roll

`MicRecorder` can't do this job: `MediaRecorder` gives an encoded blob after the
fact, so by the time energy says "speech started" the first phoneme is already
gone. The call needs raw PCM and a rolling buffer.

- `getUserMedia({echoCancellation, noiseSuppression, autoGainControl})`;
- an `AudioWorklet` (128-frame quanta) posting frames to the main thread; a ring
  buffer holds `vad_preroll_ms` of audio at all times;
- energy VAD: RMS per frame, adaptive noise floor (running percentile of the
  quiet frames), speech when RMS > floor × k for ≥ 3 consecutive frames, end
  after `vad_hangover_ms` below it. No wasm dependency — a call is close-talk
  audio and this is enough; a Silero/WebRTC VAD can drop in behind the same
  interface later;
- on endpoint: slice `[start − preroll, end + 200 ms]`, resample to 16 kHz
  (export `resampleMono` from `wav.ts` — it is already written and private),
  `encodeWav()`, hand up a `File`;
- exposes `level` at ~50 Hz for the meter, `mute()`/`unmute()` for half-duplex,
  and a hard `maxUtteranceSec` (~60 s) so a stuck VAD can't buffer forever.

### 3.3 New `lib/callPlayer.ts` — the PCM queue

One `AudioContext`, created inside the **Start call** click (autoplay policy).
`enqueue(streamResponse)` reads `response.body.getReader()`, converts Int16 → Float32
into `AudioBuffer`s, and schedules each on a running `nextStartTime` cursor so
segments butt up against each other with no gap. `stop()` cancels every scheduled
source, aborts in-flight fetches, and clears the queue — that is barge-in, and it
must be instant.

Sequencing mirrors `ReadingPlayer`: request segment *n+1* while *n* plays, and
never more than one TTS request in flight (the model serializes anyway; queuing
more just delays a barge-in cancel).

### 3.4 New `lib/callEngine.ts` — the turn state machine

`idle → warming → listening → transcribing → thinking → speaking → listening`,
plus `error`. Holds `messages: ChatMessage[]` (client-side history — stateless
backend, trivially clearable, and the same array the phone will keep). Handles
turn cancellation as one operation: abort chat SSE, `player.stop()`, drop pending
speak segments, return to `listening`.

### 3.5 `api.ts` / `types.ts`

- `chatStream(payload, onEvent, signal)` — `fetch` + `ReadableStream` SSE line
  parser (the existing `LogPanel` uses `EventSource`, which can't POST);
- `callListen(file, model, language)` → `{text}`;
- `callSpeak(payload, signal): Promise<Response>` — returns the raw `Response`;
  the player owns the body;
- `callWarmup(payload)`, `getChatModels()`, `getCallConfig()`;
- types: `ChatMessage`, `ChatEvent`, `ChatModelInfo`, `LengthPreset`, `CallConfig`.

### 3.6 `CallPanel.tsx` — the screen

**Setup strip** (auto-collapses when a call starts, remembered in `localStorage`):
`ModelSelect task="tts"` · `VoicePicker` (unchanged — built-in / saved voice /
fresh clip all work) · chat-model select · ASR model · language · **Thinking**
switch · **Response length** segmented control · an accordion for hands-free vs
push-to-talk, barge-in, VAD hangover, filler on/off.
Badge the TTS model with its measured × realtime from `/api/telemetry` and mark
streaming-capable models — that is the difference between a 1.5 s and a 4 s reply,
and it should be visible at the moment of choosing.

**The orb.** One large circular control that is both state indicator and primary
action:

| state | shows | click | hold |
|---|---|---|---|
| idle | "Start call" | warm up, then listen | — |
| warming | per-model ticks | — | — |
| listening | ring pulsing with mic level | (push-to-talk mode) send turn | talk |
| transcribing / thinking | spinner + "Denkt nach…" | cancel turn | — |
| speaking | animated bars | **interrupt** | talk (barge-in mode) |

Keyboard: `Space` hold = talk, `Esc` = interrupt/cancel turn, `Enter` = send the
typed text. The state must also be in *words* under the orb — colour and motion
alone don't say whether it is listening or thinking.

**Transcript.** Alternating bubbles; the assistant's text streams in live; the
sentence currently being spoken is highlighted (the follow-along idea
`ReadScreen`/`LibraryPanel` already use). Each user bubble carries a small
**redo** — ASR mishears, and the fix is to re-record that turn, not to argue with
the model about a word it never heard. A collapsed **thinking** disclosure appears
on turns that reasoned.

**Footer.** Mute · interrupt · end call · **Save conversation to Library**
(`POST /api/readings` with the transcript as pages — already exists, costs ~10 lines,
and turns a call into something re-listenable) · a small latency readout
(`heard 0.4s · thought 0.3s · spoke 0.9s`) that makes tuning obvious.

**Failure states, spelled out rather than generic:** audio server stopped ("Start
the server" + the button); llama.cpp unreachable (reuse `ocr.py`'s wording — name
the process and the remedy); no chat model configured (point at
`[[llama.chat_model]]`); mic denied; empty transcript ("Didn't catch that").

---

## 4. Android (`audiocpp-android`) — phase 2

Same backend, same events, so this is UI plus two audio pieces.

- **`data/Api.kt`** — `chatStream` (OkHttp SSE; the `longCallClient` timeouts, since
  a long answer outlives 240 s), `callListen` (multipart, `StreamBody`), `callSpeak`
  (returns the `ResponseBody` stream), `callWarmup`, `chatModels`, `callConfig`.
- **Mic + VAD** — `WavRecorder` already reads `AudioRecord` buffers; add a live PCM
  callback (or a sibling `MicStream`) and port §3.2's VAD verbatim so both clients
  endpoint identically. Use `MediaRecorder.AudioSource.VOICE_COMMUNICATION` plus
  `AcousticEchoCanceler` / `NoiseSuppressor` on the session id — the phone's
  platform AEC is genuinely better than the browser's, so hands-free with the
  speaker is realistic here in a way it isn't on the desktop.
- **Playback** — `AudioTrack` in streaming mode fed straight from the response
  body. Not `PlaybackEngine`: ExoPlayer wants media items, and a call wants raw
  PCM with instant stop. Take `AUDIOFOCUS_GAIN_TRANSIENT`, honour ducking, and
  stop on an incoming phone call.
- **`ui/CallScreen.kt`** + a 6th nav tab (or fold Voices into Settings if six is one
  too many). Same orb + transcript layout as §3.6.
- **`data/Settings.kt`** — chat model, thinking, response length, turn-taking mode.
- **Background** — phase 1 on the phone is foreground/screen-on only. Keeping a
  call alive in the background needs a foreground service, and per the existing
  `PlaybackService` note it must be started by connecting a `MediaController`,
  never `startForegroundService()` directly. `AudioTrack` isn't a Media3 player, so
  that pattern doesn't transfer as-is — treat it as its own follow-up rather than
  bolting it on.

---

## 5. Build order

1. **Spike (§7).** Answer the streaming-TTS question before writing anything that
   depends on it. Half an hour, and it decides §2.5 and `serverjson.py`.
2. Backend: `[[llama.chat_model]]` + `[call]` config → `speakable.py` → `chat.py` →
   `GET /api/chat/models`, `POST /api/chat`. Gate: `curl -N` the SSE stream and read
   the events; no UI yet.
3. Backend: `/api/call/listen`, `/api/call/speak`, `/api/call/warmup`. Gate:
   `curl` a WAV in, `curl` PCM out and play it with ffplay.
4. Studio: `api.ts`/`types.ts` → `lib/vad.ts` → `lib/callPlayer.ts` →
   `lib/callEngine.ts` → `CallPanel.tsx` → tab. Gate: `cd frontend; npx tsc --noEmit`,
   then `scripts\build.bat`.
5. Tune: hangover, early-flush threshold, filler delay, response-length presets,
   against the per-turn latency line.
6. Android: `Api.kt` → mic/VAD → `AudioTrack` player → `CallScreen` + tab +
   settings. Gate: `.\gradlew.bat compileDebugKotlin`.
7. Both `CLAUDE.md`s and both `README`s: new tab, new modules, new config sections,
   the streaming-TTS registration, and the "reasoning is never spoken" rule.

---

## 6. Deliberately deferred

- **WebSocket realtime path.** Browser streams mic PCM up, backend runs
  `/v1/audio/transcriptions/live` and pushes events + audio down one socket. Cuts
  another ~500 ms and enables partial transcripts *while* the user speaks — but it
  needs a streaming ASR model installed (none is) and a full rewrite of the
  transport. The event vocabulary here is already the one it would carry.
- **Server-side conversation store** (`/api/conversations`, mirroring
  `/api/readings`) so a call started on the phone continues in Studio.
- **Tool use / function calling.** Out of scope; would change the turn state machine.
- **Multi-speaker / interruption-aware turn detection** (semantic endpointing).

---

## 7. Risks and things to confirm first

- **Does a `mode: "streaming"` registration still serve plain `/v1/audio/speech`?**
  The decisive question. The CLI `dynamic_cast<IOfflineVoiceTaskSession*>` suggests a
  streaming session may *not* answer offline requests. Spike: start a second
  `audiocpp_server` on port 9091 with a temp `server.json` registering VoxCPM2 as
  `"mode": "streaming"`, then (a) POST a normal WAV request, (b) POST the streaming
  one. **If (a) works**, register VoxCPM2 streaming always — free win, no extra VRAM.
  **If it fails**, dual registration is needed and almost certainly loads the model
  twice (the server keeps "one loaded model and one offline task session per active
  model id"), so put it behind `[call].streaming_tts` and measure the VRAM cost.
  If the cost is unacceptable, the fallback path in §2.5 still gives a working call,
  just 1–3 s slower per turn.
- **Streaming PCM format.** Rate and channel count for VoxCPM2's stream are not
  documented in the server README — read them off the spike and pin them in the
  `X-Sample-Rate` header rather than assuming 24 kHz.
- **Does llama.cpp stop generating when the client disconnects?** If not, barge-in
  leaves the GPU finishing an answer nobody hears, and back-to-back interruptions
  queue up. Fallback: send `max_tokens` low enough that a stray generation is cheap.
- **llama-swap.** The chat model shares `:8080` with the OCR models. Doing OCR
  mid-call would evict the chat model and cost a reload; warm-up pins it at call
  start, but a llama-swap group (or a second llama.cpp instance on its own port —
  worth an optional per-profile `host`/`port` override in the chat profile) is the
  real fix.
- **VRAM.** Chat model + TTS + ASR now sit on one GPU, and audiocpp never unloads.
  `POST /v1/tasks/unload_models` exists — worth wiring to an "end call, free VRAM"
  action if the box gets tight.
- **Echo without headphones.** The one thing that will make hands-free feel broken.
  Half-duplex default is the mitigation; the retrigger hint (§1.2) is the escape hatch.
- **The model writes for a screen.** System prompt *and* `speakable.py` — the prompt
  alone is not reliable, and one stray `**` read as "sternchen sternchen" ruins the
  illusion.
- **A third chunker in the tree.** Justified (incremental vs. batch) but it must be
  said out loud in `CLAUDE.md`, or the next reader will "unify" them and reintroduce
  the latency.

---

## 8. What the spikes found (and what changed because of it)

Measured on this machine against the installed models. These supersede the
estimates in §1.3 and the open questions in §7.

**A streaming registration is a superset — this was the decisive result.**
Registered `mode: "streaming"`, VoxCPM2 still returns a whole WAV for an ordinary
`/api/tts` request *and* streams PCM for a call. So there is **no dual
registration and no doubled VRAM**: `catalog.py` gained a `streaming` flag,
`serverjson.py` emits `"mode": "streaming"` for the families that carry it, and
the existing TTS/ASR panels are untouched. The same holds for Nemotron ASR.

| measurement | result |
|---|---|
| VoxCPM2 streaming, first audio | **467 ms** (vs 1.46 s for the complete clip) |
| VoxCPM2 streaming **with a voice clone** | 792 ms to first audio |
| VoxCPM2 throughput | 2.9–4.9× realtime · output is **48 kHz mono s16le** |
| Nemotron ASR, 22 s of German | 678 ms (RTF 0.03); first transcript delta at 307 ms |
| gemma-4-e4b-it, cold (llama-swap load) | TTFT **4878 ms** |
| gemma-4-e4b-it, warm | TTFT **151–179 ms**, ~165 tok/s |
| **Full turn: ASR 485 ms + first segment 379 ms + first audio 380 ms** | **≈1.2 s to first sound** |

Three things the plan did not anticipate:

1. **VoxCPM2 in streaming mode rejects `retry_badcase`** ("VoxCPM2 streaming
   generation requires retry_badcase=false") — which would have 500'd every
   existing `/api/tts` call the moment streaming was switched on. Fixed where no
   client has to know: `default_request_options = {"retry_badcase": "false"}` in
   the catalog entry, verified to be applied server-side.
2. **A streaming ASR session silently drops the final partial window.** A 4.6 s
   turn ending "…und ein paar Eier da" came back as "…und ein paar". Not an
   error, not a warning — just the last words missing, so the model would answer
   a question it never fully heard. One second of trailing silence
   (`_pad_wav_tail`) flushes it; the same audio through offline Qwen3-ASR was
   always complete, which is what identified it as streaming-specific.
   Relatedly, the warm-up's 200 ms of silence was *shorter than one window* and
   was rejected outright — it is now 1.5 s.
3. **Thinking is spent from the answer's token budget.** "Kurz" (140 tokens) with
   thinking on produced ~1400 characters of reasoning, hit the cap, and returned
   no answer at all — the `ocr.py` guard fired and the turn failed. Fixed with a
   separate `[call].thinking_tokens` (900) added on top of the preset, so the
   switch is usable at every length. The cost is honest and now stated in the UI:
   TTFT goes from ~180 ms to ~2.2 s.

**Design changes from the plan.** Chat models are **discovered** from llama.cpp's
`/v1/models` rather than declared as `[[llama.chat_model]]` profiles — llama-swap
already knows all 18 of them, and the dropdown showing "loaded" status is better
UX than a list that goes stale. `[call]` config therefore only carries what
llama.cpp cannot report: the system prompt, the length presets, and the
turn-taking defaults.
