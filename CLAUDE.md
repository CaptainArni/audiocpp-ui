# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

audio.cpp Studio is a **local launcher/UI** (native desktop window via pywebview, or browser) for an external CUDA inference binary, `audiocpp_server.exe` (from the separate [audio.cpp](https://github.com/0xShug0/audio.cpp) project). It does TTS, voice cloning, and ASR by controlling and proxying to that binary — it does **not** do inference itself. It also proxies **page-photo OCR** to a separate `llama.cpp` vision server, keeps a **library of saved readings**, and exposes an **OCR test bench** and **telemetry**. It is the backend the [Android companion app](../audiocpp-android) talks to. Windows-first local tool, not a portable/packaged installer.

## Commands

All commands run from the project root on Windows (PowerShell), using the local `.venv`.

```powershell
# First-time setup
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
.\scripts\build.bat            # npm install + vite build, copies dist/ → backend/static/

# Run (both serve http://127.0.0.1:8000)
.\.venv\Scripts\python backend\desktop_app.py    # native window  (or scripts\launch_desktop.bat)
.\.venv\Scripts\python backend\browser_app.py    # default browser (or scripts\launch_browser.bat)

# Dev with hot reload — two terminals:
cd backend; ..\.venv\Scripts\python -m uvicorn main:app --reload   # API on :8000
cd frontend; npm run dev                                           # Vite on :5173, proxies /api → :8000
```

VS Code tasks (Terminal → Run Task) wrap these: **Build Frontend**, **Launch Desktop**, **Launch Browser**, **Build + Launch Desktop/Browser**. `launch.json` has debug configs (`Python Debugger: FastAPI` for reload dev).

- **Frontend must be built** into `backend/static/` before either entrypoint works; otherwise the backend serves a "Frontend not built" placeholder. Re-run `scripts\build.bat` after frontend changes (it deletes and recopies `backend/static/`).
- The frontend build (`vite build`) does **not** type-check. Run `cd frontend; npx tsc --noEmit` to type-check against `tsconfig.json`.
- **No linter** is configured. There *is* a small test suite, covering only the
  pure functions whose bugs are silent (a wrong cut is a bad pause, not an
  exception) — everything else here is I/O and UI where tests would cost more
  than they catch:

```powershell
.\.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
.\.venv\Scripts\python -m pytest tests    # speakable.py, WAV headers, store-id guards
cd frontend; npm test                     # chunk.ts, via node's built-in runner
```

  `frontend/src/lib/chunk.test.ts` and the Android app's `ChunkerParityTest` both
  assert **the same fixture**, `tests/fixtures/chunking.json` — the two chunkers
  are hand-ported copies of one algorithm, and a divergence is invisible until
  the phone and the desktop produce different audio for the same reading. The
  Android repo carries a duplicate of that file (separate git repos); change one,
  change the other. `npm test` needs no test framework: node strips the TS types.

## Configuration

`config.toml` (project root) is loaded by `backend/config.py`. **`data/config.toml` overrides the root file if it exists** (data/ is gitignored — this is the mechanism for a local machine-specific override). Two unrelated concerns share the file:
- `[server]` / `[server.cors]` / `[desktop]` — this app (the FastAPI/uvicorn UI, `:8110` in the committed config; `0.0.0.0` so the Android app can reach it over the LAN).
- `[audiocpp]` — the **external** binary this app controls: `exe` path, `models_dir`, and its host/port (`:9090`), device, threads.
- `[llama]` + `[[llama.ocr_model]]` — the **external** `llama.cpp` vision server used for OCR (`:8080`, not spawned by this app), plus the selectable OCR-model profiles and `default_ocr_model`.
- `[media]` — ffmpeg for audio/video uploads: tool paths (blank = PATH), duration/size caps, upload retention, and `asr_timeout_sec` (how long `proxy.transcribe` waits — an hour of audio is one non-streaming request).
- `[call]` + `[[call.length]]` — the **Call** tab: default chat/TTS/ASR model, the spoken-conversation `system_prompt`, response-length presets, `thinking_tokens`, `code_placeholder`, and the VAD/filler defaults every client reads from `/api/call/config`. The `system_prompt` must ask for ``` fences around code rather than banning code blocks — see `speakable.py` below. **Chat models are deliberately not listed here** — they are discovered from the llama.cpp server's `/v1/models`, because llama-swap already knows them and a second hand-written list would only go stale.

Editing `[audiocpp].exe` or `models_dir` is how you point the app at a different build or model collection.

## Architecture

Three tiers, three processes:

```
pywebview window ──or── browser ──or── Android companion app
        │  (loads SPA / REST, calls /api/*)
        ▼
FastAPI backend (uvicorn, :8110)   ← this repo
        │  spawns / proxies
        ├──────▼  audiocpp_server.exe (CUDA, :9090)  ← external; TTS / cloning / ASR
        └──────▼  llama.cpp server (:8080)           ← external; vision OCR (photo → text)
```

Ports come from `config.toml` (`[server]` :8110, `[audiocpp]` :9090, `[llama]` :8080). The backend is a **thin proxy + process manager + file store** in front of `audiocpp_server`. The audio server speaks an OpenAI-compatible HTTP API (`/health`, `/v1/models`, `/v1/audio/speech`, `/v1/audio/transcriptions`); the backend adds model discovery, process lifecycle, log streaming, upload/output file handling, OCR proxying, a readings store, and telemetry on top. Only `audiocpp_server` is spawned/managed by Studio; the `llama.cpp` OCR server is started separately (e.g. llama-swap).

### Backend module responsibilities (`backend/`)

- **`main.py`** — all FastAPI routes and SPA serving. The catch-all `/{full_path}` SPA route **must stay registered last**. `/assets` (hashed bundles) are cacheable; `index.html` is served `no-store`. A pure-ASGI `AccessLogMiddleware` logs every `/api/*` request to the log bus (skipping the high-frequency pollers in `_QUIET_PATHS`); it must **not** be a `BaseHTTPMiddleware` or it would buffer the SSE log stream.
- **`logbus.py`** — `LogBus` **singleton** (`log_bus`), the single sink for all log lines (app endpoint/generation activity **and** the child process's raw stdout/stderr). Keeps a bounded backlog, mirrors each entry to stdlib `logging` (so it also lands in the uvicorn console), and fans entries out to SSE subscribers. Entry schema: `{t, source: "app"|"server", level, line}` where level ∈ `debug|info|success|warn|error|stdout|stderr`. **Add generation/endpoint logging by calling `log_bus.emit(...)`.**
- **`config.py`** — `AppConfig` **singleton** (`AppConfig.get()`) wrapping `config.toml`. Also owns all runtime paths (`uploads/`, `generated/`, `static/`, `server.json`), creating dirs on access.
- **`catalog.py`** — the **source of truth for "known" models**. Maps a downloaded model *directory name* → loader `family`, `task` (`tts`/`asr`), and capability flags (`clone`, `voice_design`, built-in voice kind, load/session options). **To add support for a new model, add a matcher here.** Directories with no match are surfaced to the UI as unknown and cannot be started.
- **`models.py`** — `scan_models()` lists `models_dir`, enriches each dir via `lookup_catalog`, and enumerates built-in voices/languages (pocket-tts languages, kokoro voices) by reading the model's files.
- **`serverjson.py`** — writes `server.json` (into `generated/`) for the selected models. **Every model is registered `lazy: true`** — the server starts fast and loads a model into VRAM only on its first request (lazy multi-model), and never unloads it. Model selection therefore switches per request without a restart. `mode` is `"streaming"` for catalog entries flagged `streaming`, else `"offline"`: **a streaming session is a superset** — verified that VoxCPM2 and Nemotron still answer ordinary non-streaming requests while also being able to emit chunks — so it costs no extra VRAM and leaves `/api/tts` and `/api/transcribe` untouched. Only flag a family measured to work both ways. Changing the flag needs an audio-server **restart** to take effect.
- **`process.py`** — `ServerManager` **singleton** owning the `audiocpp_server` child process. Spawns it with `--config server.json`, reads stdout/stderr on daemon threads (emitting them to `log_bus` as `source="server"`), polls `/health` until `running` (90s deadline). State machine: `stopped → starting → running / error`. On Windows uses `CREATE_NO_WINDOW` and `taskkill /T /F` (whole tree) to stop.
- **`proxy.py`** — `httpx` calls to the audio server's endpoints. Logs each outbound generation/ASR command (the exact body, long fields truncated) plus upstream status/timing/size to `log_bus`. `AudiocppError` (→ HTTP 502) distinguishes upstream failures from client errors (→ 400) in `main._fail`.
- **`media.py`** — the single ffmpeg wrapper: `probe()` (ffprobe → duration/streams), `to_wav()` (any container → mono 16-bit PCM at a given rate, `-vn` so a video costs only its audio track), `support()`, and `prune_uploads()`. ffmpeg is a **soft dependency** resolved from `[media].ffmpeg` then PATH — without it everything still works, only non-WAV uploads are refused. Subprocesses run with `CREATE_NO_WINDOW` on Windows, like `process.py`.
- **`chat.py`** — `ocr.py`'s **streaming, text-only sibling**: `/v1/chat/completions` with `stream: true` for the Call tab. Splits `content` from `reasoning_content` at the source (**reasoning is shown but never spoken**) and feeds only `content` to `speakable.SentenceStreamer`, emitting a `speak` event per ready segment. Chat models come from `list_models()` (llama.cpp's `/v1/models`), not from config. A template that rejects `chat_template_kwargs` is retried once without it and remembered in `_NO_THINKING_KWARG`. Carries the same "only reasoning, no answer" guard `ocr.py` documents — in a call, silence is indistinguishable from a hang.
- **`speakable.py`** — `to_speakable()` strips what a model writes for a screen (markdown, bullets, code fences, URLs, emoji) because TTS reads every asterisk aloud and the system prompt alone is not reliable; `SentenceStreamer` cuts the *growing* answer into speakable segments. **This is a third chunker on purpose**: `lib/chunk.ts`/`Chunker.kt` split a complete text for even chunk sizes, this one splits an incomplete one for latency, and its first segment may end at a clause boundary so the first clause reaches the synthesiser early. Do not "unify" them. Tested in `tests/test_speakable.py`, which is where the non-obvious rules are pinned:
  - **A fenced block is opaque — never cut inside one.** Code is full of periods and blank lines, so a cut that lands mid-block both leaks source to the speaker and leaves each remaining piece looking like a fresh dangling opener, announcing one snippet several times over. Prose *before* a fence is complete by definition and is spoken immediately; an unclosed fence is held.
  - **A code block is announced, not dropped** (`[call].code_placeholder`). Silence with the answer visible on screen is indistinguishable from broken TTS. This only works if the model *marks* the code: the system prompt must ask for ``` fences rather than forbidding code blocks, or the model writes bare code as prose and it is read out character by character. (Measured on gemma-4-e4b: that is exactly what a "keine Codeblöcke" prompt produced.)
  - **Single letters before a period are abbreviations.** German sets them spaced — `z. B.`, `u. a.`, `d. h.` — so an abbreviation list holding only the closed-up `z.b` form left the common case unguarded, and the assistant paused in the middle of "zum Beispiel".
- **`ocr.py`** — page-photo OCR via the **`llama.cpp` vision server** (`/v1/chat/completions`). OCR models are **profiles** declared as `[[llama.ocr_model]]` in `config.toml` (`config.llama_ocr_models` / `llama_ocr_model_by_id`); each profile carries its own `model` name, `prompt`, and request-shaping (`send_thinking_kwarg`, `repeat_penalty`, …) because families differ — **PaddleOCR-VL wants the literal prompt `OCR:` and no thinking kwarg; Gemma wants the German instruction prompt with thinking disabled**. `transcribe_image(image, prompt=, model_id=)` resolves a profile and builds the request. Used by `/api/ocr` (the phone + the OCR test bench).
- **`metrics.py`** — `metrics` **singleton**: a small thread-safe in-memory store fed after each successful TTS/ASR/OCR (per-model warm/cold + throughput + a recent-events ring). `warmed` = served a request since the audio server last (re)started (reset via `metrics.on_server_start()` in `/api/server/start`). Read via `/api/telemetry`. Not persisted.

### Key flows

- **Start server** (`POST /api/server/start`): scan models → keep only known (`family` and `task` set) and any requested `modelIds` → `generate_server_json` → `ServerManager.start` spawns the exe → a poll thread flips state to `running` once `/health` responds.
- **Log streaming** (`GET /api/server/logs`, SSE): `log_bus` pushes entries onto per-subscriber `asyncio.Queue`s via `loop.call_soon_threadsafe`; on connect it first replays `log_bus.snapshot()`. The event loop is captured in the FastAPI `lifespan` startup (`log_bus.set_loop`) — without it the worker threads can't post.
- **TTS/ASR**: `main.py` builds the OpenAI-style request body and calls `proxy.speech`/`proxy.transcribe`. Generated WAVs are written to `generated/` and returned; the filename comes back in the `X-Generation-Name` header.
- **Saved voices**: `/api/voices` (list/save/delete/audio) persists a reference clip + transcript under `backend/voices/` (`<uuid>.wav` + `<uuid>.json`, gitignored). `/api/tts` accepts `savedVoiceId`, which resolves to `voice_ref` + the stored `reference_text`.
- **Uploads**: reference clips / ASR audio / video are saved to `uploads/` with a UUID name. `_upload_path`/generation serving both `resolve()` and verify the parent dir to block path traversal. `/api/uploads` accepts **any audio or video** ffmpeg can read: a `.wav` sent with no `rate` form field is stored untouched (the reference-clip path, byte-identical to before), anything else is streamed to disk, probed, and transcoded to mono 16-bit PCM at `rate` (ASR callers send 16000). Bodies are **streamed in chunks, never `read()` whole** — a video is uploaded entire and only its audio survives. `GET /api/media/support` tells the clients whether ffmpeg exists before they offer a video picker. `uploads/` is pruned on startup and after each upload (`[media].uploads_retention_hours`) because video-derived audio is large: 1 h at 16 kHz mono ≈ 115 MB. The Studio frontend still converts plain audio client-side (`fileToWavUpload` in `lib/wav.ts`) because that is faster than a round trip.
- **OCR**: `POST /api/ocr` (multipart image + optional `model` / `prompt`) → `ocr.transcribe_image` → the `llama.cpp` server. `GET /api/ocr/models` lists the selectable profiles (with their effective prompt) for the phone's picker and the test bench.
- **Readings (Library)**: named page-text sets under `backend/readings/` (`<uuid>.json`, gitignored). `GET/POST /api/readings`, `GET/PUT/DELETE /api/readings/{id}`. Shared store — created on the phone or in Studio, edited/played from either.
- **Voice call**: `GET /api/call/config` (chat models + presets + VAD defaults, one request so no client hardcodes a copy) → `POST /api/call/warmup` (loads all three models *and* synthesises the filler clip in the chosen voice; lazy loading means the first request per model pays a full VRAM load, so paying it here is the difference between a 30 s first turn and a 1 s one) → per turn: `POST /api/call/listen` (multipart WAV → transcript, upload+ASR fused into one round trip) → `POST /api/chat` (SSE: `text`/`reasoning` deltas, `speak` segments, `done`) → `POST /api/call/speak` per segment (chunked **raw PCM**, `X-Sample-Rate`/`X-Channels`/`X-Sample-Format` headers). `/api/call/speak` has **one response shape for both paths** — a streaming model is proxied through as it generates, anything else renders the WAV and sends its PCM — so a client has a single playback path and only the time-to-first-byte differs. Measured turn: ASR 485 ms + first segment 379 ms + first audio 380 ms ≈ **1.2 s to first sound**.
  - **`_pad_wav_tail`**: a streaming ASR session consumes fixed windows and silently discards the leftover. Without one second of trailing silence Nemotron transcribed a 4.6 s turn ending "…und ein paar Eier da" as "…und ein paar" — the last words gone, so the model answers a question it never fully heard. Padding is unconditional; offline models don't need it and don't care.
  - **Thinking** grants `[call].thinking_tokens` *on top of* the length preset: reasoning is spent from the same `max_tokens` as the answer, so "Kurz" + thinking otherwise reasons to the cap and never speaks (measured on gemma-4-e4b: ~1400 chars of reasoning against a 140-token budget).
- **Telemetry**: `GET /api/telemetry` returns `server_manager.status()` + `metrics.snapshot()`; handlers call `metrics.record(...)` on each successful generation (`kind` ∈ `tts|asr|ocr|chat`).

### Frontend (`frontend/src/`, React 19 + Mantine 9, Vite)

- **`api.ts`** — the single API client; every call hits `/api/*` (same origin in prod, Vite-proxied in dev). **`types.ts`** mirrors the backend JSON shapes — keep the two in sync when changing an endpoint.
- **`App.tsx`** — polls `/api/server/status` every 2s, loads models once, and hosts the TTS/ASR tabs plus `ServerControlBar`.
- Components under `components/` (TtsPanel, AsrPanel, VoicePicker, ModelSelect, MicRecorder, LogPanel, OutputPlayer, **LibraryPanel**, **OcrPanel**, **TelemetryPanel**, etc.). Capability flags from the catalog drive the UI: `builtinVoices` → built-in voice dropdown, `clone` → saved-voice dropdown, `voiceDesign` → instructions textarea.
- **Voices are managed in exactly one place.** `VoicesPanel` creates (upload/record), previews, and deletes them; `VoicePicker` everywhere else only *chooses* one — no upload, record, preview or delete. Five panels each carrying the full clone UI was five copies of one job, and put a delete button next to a dropdown people use constantly. `VoiceValue` is therefore just `{mode, voiceId, savedVoiceId}`; the old ad-hoc `upload`/`referenceText` path is gone, so a clip must be saved as a voice before it can be used. The picker also snaps `mode` to one the model actually offers, or a clone-only model (Higgs has no built-in voices) would show an empty built-in dropdown with no way out.
- **Tabs** (in `App.tsx`): Text to Speech · Transcribe · **Call** · Saved Voices · Library · OCR · Telemetry.
- **Saved conversations** (`/api/conversations`, `backend/conversations/`) mirror the readings store, but are **never written automatically**. A call is something someone had out loud in their own room; filing every one of them away by itself is a surprise, not a feature. Save is a button, on both clients, and it re-saves in place once a conversation has an id. What is stored is exactly the `messages` array `/api/chat` takes back, which is what makes a saved call *resumable* rather than only readable — loading one before dialling is the normal order. Store ids come off the URL, so both stores share `_store_path`, whose character class (not just the resolved-parent check) is the actual guard.
- **`CallPanel`** + `lib/vad.ts` + `lib/callPlayer.ts` + `lib/callEngine.ts` — the voice call.
  - **`vad.ts`** cannot reuse `MicRecorder`: `MediaRecorder` returns an encoded blob *after* the fact, so by the time an energy meter says "speech started" the first phoneme is gone. It keeps raw PCM in a rolling buffer and cuts each utterance with a **pre-roll that begins before the speaker did**. The detector is a plain energy gate with an adaptive noise floor (tracked only while nobody is talking, so a long sentence can't drag its own threshold up); `VadOptions` is the seam for swapping in a real VAD.
  - **`callPlayer.ts`** schedules incoming PCM onto a running `AudioContext` cursor so segments butt together with no gap. Its `AudioContext` **must be unlocked inside the "Start call" click** or autoplay policy leaves the first reply silent with no error. `stop()` is barge-in and cancels every scheduled source, which is why they are all tracked.
  - **`callSession.ts`** owns the engine at **module scope**, and `CallPanel` only subscribes (`useSyncExternalStore`). The panel must not own it: Mantine `Tabs` defaults to `keepMountedMode: "activity"`, and React 19's `<Activity>` re-runs effects on hide — so an unmount cleanup that hung up fired every time you glanced at another tab, releasing the mic and ending the call. Same reason `ReaderApp` owns the Android playback engine. Only "End call" tears it down.
  - **`callEngine.ts`** owns the turn state machine and keeps the conversation client-side (the backend is stateless).
  - **Cancelling a turn repairs the history**: the user message is appended at turn start and the assistant's only on `done`, so an interruption in between would leave an unanswered user turn — two user messages in a row next turn, and the part already spoken aloud missing from the model's own context, which made it repeat itself. `spokenSoFar` is kept as the assistant message; if nothing was spoken the question is dropped.
  - **`error` is recoverable** (`resume()`): a failed turn costs the turn, not the conversation. Tapping the orb carries on. Cancelling a turn is deliberately *one* operation — abort the chat SSE, drop queued segments, reopen the mic — or the assistant talks over its own interruption. After a reply it waits out `player.queuedSeconds` before reopening the mic, otherwise the hands-free VAD hears the assistant's tail and answers itself.
  - **Every setting is live; they differ only in when they bite** — which is what `settingsNote` says out loud. Mic sensitivity and barge-in take effect at once (they configure the devices), length/thinking/language from the next turn (they are request parameters, and the turn in flight was already sent), a model or the voice after a re-warm. Nothing here needs the call to end first, so nothing is disabled during one.
  - **Mic sensitivity is a slider, not a constant** (`VadOptions.speechFactor`, applied live via `MicVad.setSpeechFactor`). One threshold cannot serve both a quiet talker in a still room and a normal voice next to a fan. The control is **inverted** on purpose: right = a *lower* factor = picks up more, because a slider that gets less sensitive as you drag right is worse than no slider.
  - **Context trimming is announced** (`{type:"context", dropped, kept}`, sent before the model is contacted). `[call].context_messages` silently dropped the start of a long call, and an assistant that forgets the beginning for no visible reason reads as a broken model.
  - Half-duplex is the default (mic gated while speaking); barge-in is opt-in and labelled "works best with headphones", because a false interruption mid-sentence is worse than pressing a button.
  - The **filler clip covers thinking, not synthesis**: it is cancelled the moment the first `speak` event arrives. It shares the player's audio cursor, so a filler fired after the answer exists would both claim the model is still thinking (with the answer already on screen) *and* push the real reply back by its own duration.
  - `thinking` vs **`preparing`** are separate phases because they are different waits with different causes — a slow model versus a cold TTS model. Both are interruptible, along with `speaking`; see `CallEngine.answering`.
  - **Changing a model or voice mid-call re-warms** (`rewarm()`, latest-wins via `warmToken`, deferred while a turn is in flight). Warm-up otherwise runs once against whatever was selected at call start, so a switch would leave the replacement cold *and* the filler clip in the previous voice.
- **`TextPlayer`** — the shared "read this text aloud" player: chunks with `lib/chunk.ts` (a port of the Android `Chunker`, keep in sync) and synthesizes chunk-by-chunk so audio starts on the first chunk instead of after the last. Used by **`LibraryPanel`** (a saved reading) and **`AsrPanel`** (speaking a transcript back in another voice) — the same job in both cases: some text, a voice, and playback that must not wait for the whole thing to render.
- **`LibraryPanel`** — lists saved readings (shared with the phone via `/api/readings`), reads them aloud via `TextPlayer`, edits/creates readings, and creates a reading from pasted text.
- **`OcrPanel`** — the OCR test bench: drop an image, pick a model + edit the prompt (prefilled from `/api/ocr/models`), run `/api/ocr`, and A/B results with timing.
- **`TelemetryPanel`** — polls `/api/telemetry` every 2s for server state + per-model warm/throughput and a recent-generations feed. Also owns **Free VRAM** (`POST /api/server/unload` → the audio server's `unload_all_models`, or `unload_models` for one row): models load lazily and are then held forever, which is right for latency and wrong on a box that also runs a 27B chat model, where the only escape used to be restarting the server. Reloading is transparent, so this costs the next request its load time and nothing else. The button is gated only on the server running, not on the warm count — `warmed` describes what *this* backend has served, so a zero there would sometimes refuse to free VRAM that really is held. Warm-up records its own `metrics.record` for exactly this reason; without it a call left three models loaded that telemetry called cold.
- A **completed** turn reports its latency (`POST /api/call/turn`, recorded under the pseudo-model `voice call` — a turn is a pipeline, not a model). Interrupted turns are not reported: they measure how long someone waited before giving up.
- **`LogPanel`** — the log viewer is a **Monaco** editor (`@monaco-editor/react`). Monaco is loaded from a **CDN** (`lib/monaco.ts` pins the version via `loader.config`) — it is **not** bundled, so `monaco-editor` is a devDependency for types only. `lib/logLanguage.ts` registers the `audiocpp-log` Monarch language + theme for syntax highlighting; per-line level is shown with gutter bars / background tints via editor decorations (kept separate from token colours so they don't clash).
- **`AsrPanel`** — input sources behind a segmented control (an **audio/video dropzone** and the **microphone**), and, once a transcript exists, a **"Read it aloud"** section: its own TTS model + `VoicePicker` + `TextPlayer`, so a recording can be replayed in a different (or cloned) voice without first saving it as a reading. The model choice has its own storage slot (`asr.speak.tts`) so it doesn't fight the TTS tab's. Video (and anything `decodeAudioData` rejects) is sent to the backend for ffmpeg extraction with an upload progress bar; plain audio still converts client-side. Karaoke word-highlighting needs no special case — `/api/uploads/{id}/audio` serves the converted 16 kHz WAV whatever the source was.
- **`MicRecorder`** — shared by voice cloning and Transcribe; `targetRate` (16 kHz for ASR), labels, and a `maxSeconds` auto-stop are props, since `MediaRecorder` holds every chunk in memory.
- **`lib/wav.ts`** — mic recordings (WebM/Opus) and any non-WAV uploaded file (mp3/webm/ogg/m4a/flac/…) are decoded via `AudioContext` and re-encoded to mono 16-bit PCM WAV client-side, which is faster than uploading. `isProbablyVideo()` picks out what must go to the backend instead.

## Windows-specific notes

`desktop_app.py` carries several Windows workarounds, all best-effort (wrapped in try/except): setting an explicit AppUserModelID so the taskbar shows a custom icon; applying title-bar/taskbar icons via GDI+/Win32 (pywebview's `icon=` is ignored on Windows); and attaching a WebView2 `PermissionRequested` handler to auto-allow the microphone. `main.py` also registers `application/javascript` for `.js` because Windows otherwise serves ES modules as `text/plain`.
