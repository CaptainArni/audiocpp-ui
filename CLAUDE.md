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
- **No test suite and no linter** are configured in this repo.

## Configuration

`config.toml` (project root) is loaded by `backend/config.py`. **`data/config.toml` overrides the root file if it exists** (data/ is gitignored — this is the mechanism for a local machine-specific override). Two unrelated concerns share the file:
- `[server]` / `[server.cors]` / `[desktop]` — this app (the FastAPI/uvicorn UI, `:8110` in the committed config; `0.0.0.0` so the Android app can reach it over the LAN).
- `[audiocpp]` — the **external** binary this app controls: `exe` path, `models_dir`, and its host/port (`:9090`), device, threads.
- `[llama]` + `[[llama.ocr_model]]` — the **external** `llama.cpp` vision server used for OCR (`:8080`, not spawned by this app), plus the selectable OCR-model profiles and `default_ocr_model`.

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
- **`serverjson.py`** — writes `server.json` (into `generated/`) for the selected models. **Every model is registered `lazy: true, mode: "offline"`** — the server starts fast and loads a model into VRAM only on its first request (lazy multi-model). Model selection therefore switches per request without a restart.
- **`process.py`** — `ServerManager` **singleton** owning the `audiocpp_server` child process. Spawns it with `--config server.json`, reads stdout/stderr on daemon threads (emitting them to `log_bus` as `source="server"`), polls `/health` until `running` (90s deadline). State machine: `stopped → starting → running / error`. On Windows uses `CREATE_NO_WINDOW` and `taskkill /T /F` (whole tree) to stop.
- **`proxy.py`** — `httpx` calls to the audio server's endpoints. Logs each outbound generation/ASR command (the exact body, long fields truncated) plus upstream status/timing/size to `log_bus`. `AudiocppError` (→ HTTP 502) distinguishes upstream failures from client errors (→ 400) in `main._fail`.
- **`ocr.py`** — page-photo OCR via the **`llama.cpp` vision server** (`/v1/chat/completions`). OCR models are **profiles** declared as `[[llama.ocr_model]]` in `config.toml` (`config.llama_ocr_models` / `llama_ocr_model_by_id`); each profile carries its own `model` name, `prompt`, and request-shaping (`send_thinking_kwarg`, `repeat_penalty`, …) because families differ — **PaddleOCR-VL wants the literal prompt `OCR:` and no thinking kwarg; Gemma wants the German instruction prompt with thinking disabled**. `transcribe_image(image, prompt=, model_id=)` resolves a profile and builds the request. Used by `/api/ocr` (the phone + the OCR test bench).
- **`metrics.py`** — `metrics` **singleton**: a small thread-safe in-memory store fed after each successful TTS/ASR/OCR (per-model warm/cold + throughput + a recent-events ring). `warmed` = served a request since the audio server last (re)started (reset via `metrics.on_server_start()` in `/api/server/start`). Read via `/api/telemetry`. Not persisted.

### Key flows

- **Start server** (`POST /api/server/start`): scan models → keep only known (`family` and `task` set) and any requested `modelIds` → `generate_server_json` → `ServerManager.start` spawns the exe → a poll thread flips state to `running` once `/health` responds.
- **Log streaming** (`GET /api/server/logs`, SSE): `log_bus` pushes entries onto per-subscriber `asyncio.Queue`s via `loop.call_soon_threadsafe`; on connect it first replays `log_bus.snapshot()`. The event loop is captured in the FastAPI `lifespan` startup (`log_bus.set_loop`) — without it the worker threads can't post.
- **TTS/ASR**: `main.py` builds the OpenAI-style request body and calls `proxy.speech`/`proxy.transcribe`. Generated WAVs are written to `generated/` and returned; the filename comes back in the `X-Generation-Name` header.
- **Saved voices**: `/api/voices` (list/save/delete/audio) persists a reference clip + transcript under `backend/voices/` (`<uuid>.wav` + `<uuid>.json`, gitignored). `/api/tts` accepts `savedVoiceId`, which resolves to `voice_ref` + the stored `reference_text`.
- **Uploads**: reference clips / ASR audio are saved to `uploads/` with a UUID name. `_upload_path`/generation serving both `resolve()` and verify the parent dir to block path traversal. **Uploads are WAV-only on the backend** (validated in `/api/uploads`); the frontend converts other audio formats to WAV client-side before uploading (`fileToWavUpload` in `lib/wav.ts`).
- **OCR**: `POST /api/ocr` (multipart image + optional `model` / `prompt`) → `ocr.transcribe_image` → the `llama.cpp` server. `GET /api/ocr/models` lists the selectable profiles (with their effective prompt) for the phone's picker and the test bench.
- **Readings (Library)**: named page-text sets under `backend/readings/` (`<uuid>.json`, gitignored). `GET/POST /api/readings`, `GET/PUT/DELETE /api/readings/{id}`. Shared store — created on the phone or in Studio, edited/played from either.
- **Telemetry**: `GET /api/telemetry` returns `server_manager.status()` + `metrics.snapshot()`; handlers call `metrics.record(...)` on each successful generation.

### Frontend (`frontend/src/`, React 19 + Mantine 9, Vite)

- **`api.ts`** — the single API client; every call hits `/api/*` (same origin in prod, Vite-proxied in dev). **`types.ts`** mirrors the backend JSON shapes — keep the two in sync when changing an endpoint.
- **`App.tsx`** — polls `/api/server/status` every 2s, loads models once, and hosts the TTS/ASR tabs plus `ServerControlBar`.
- Components under `components/` (TtsPanel, AsrPanel, VoicePicker, ModelSelect, MicRecorder, LogPanel, OutputPlayer, **LibraryPanel**, **OcrPanel**, **TelemetryPanel**, etc.). Capability flags from the catalog drive the UI: `builtinVoices` → voice dropdown, `clone` → "Clone from clip", `voiceDesign` → instructions textarea.
- **Tabs** (in `App.tsx`): Text to Speech · Transcribe · Saved Voices · Library · OCR · Telemetry.
- **`LibraryPanel`** — lists saved readings (shared with the phone via `/api/readings`), reads them aloud in the browser via a **streaming reading player** (chunks the text with `lib/chunk.ts` — a port of the Android `Chunker`, keep in sync — and synthesizes chunk-by-chunk, playing back-to-back), edits/creates readings, and creates a reading from pasted text.
- **`OcrPanel`** — the OCR test bench: drop an image, pick a model + edit the prompt (prefilled from `/api/ocr/models`), run `/api/ocr`, and A/B results with timing.
- **`TelemetryPanel`** — polls `/api/telemetry` every 2s for server state + per-model warm/throughput and a recent-generations feed.
- **`LogPanel`** — the log viewer is a **Monaco** editor (`@monaco-editor/react`). Monaco is loaded from a **CDN** (`lib/monaco.ts` pins the version via `loader.config`) — it is **not** bundled, so `monaco-editor` is a devDependency for types only. `lib/logLanguage.ts` registers the `audiocpp-log` Monarch language + theme for syntax highlighting; per-line level is shown with gutter bars / background tints via editor decorations (kept separate from token colours so they don't clash).
- **`lib/wav.ts`** — mic recordings (WebM/Opus) and any non-WAV uploaded file (mp3/webm/ogg/m4a/flac/…) are decoded via `AudioContext` and re-encoded to mono 16-bit PCM WAV client-side so everything fits the WAV-only upload path.

## Windows-specific notes

`desktop_app.py` carries several Windows workarounds, all best-effort (wrapped in try/except): setting an explicit AppUserModelID so the taskbar shows a custom icon; applying title-bar/taskbar icons via GDI+/Win32 (pywebview's `icon=` is ignored on Windows); and attaching a WebView2 `PermissionRequested` handler to auto-allow the microphone. `main.py` also registers `application/javascript` for `.js` because Windows otherwise serves ES modules as `text/plain`.
