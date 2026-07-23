# audio.cpp Studio

A local **desktop app** (and browser app) for [audio.cpp](https://github.com/0xShug0/audio.cpp): generate **TTS**, **clone a voice** from an uploaded clip **or a live mic recording**, **transcribe** audio (ASR), run **page-photo OCR**, keep a **library of readings**, and **start/stop** the inference server — from a native window or your browser. It's also the backend for the [Android companion app](https://github.com/CaptainArni/audiocpp-android).

## Architecture

```
pywebview window ──or── browser ──or── Android companion app
        │  (loads SPA / REST, calls /api/*)
        ▼
FastAPI backend (uvicorn, :8110)   ← this repo; serves the built React SPA + /api/*
        │  spawns / proxies
        ├──────▶ audiocpp_server.exe (CUDA, :9090)   TTS · voice cloning · ASR
        └──────▶ llama.cpp server     (:8080)        vision OCR (page photo → text)
```

The FastAPI backend serves the built React/Mantine frontend **and** manages `audiocpp_server`: it scans the models directory, generates `server.json` (lazy multi-model), spawns/stops the process, streams its logs (SSE), saves uploaded reference clips, and proxies TTS/ASR. It **proxies OCR** to a separately-run `llama.cpp` vision server, stores **saved readings**, and exposes **telemetry**. Model selection switches per request without a restart.

```
audiocpp-ui/
  frontend/        React + Mantine (Vite)         → built into backend/static
  backend/         FastAPI app + desktop/browser entrypoints
    main.py          FastAPI: /api/* + SPA serving
    desktop_app.py   pywebview native window
    browser_app.py   opens default browser
    ocr.py           page-photo OCR via llama.cpp (model profiles)
    metrics.py       in-memory telemetry store
    config.py catalog.py models.py serverjson.py process.py proxy.py
    requirements.txt
  config.toml      settings (ports, paths, OCR model profiles)
  scripts/build.bat
  .vscode/         tasks.json + launch.json
```

## Prerequisites

- Windows with the **WebView2 runtime** (preinstalled on Windows 11).
- `audiocpp_server.exe` built (CUDA preset) and at least one downloaded model — see `config.toml`.
- Python 3.11+ and Node.js 18+.
- *(Optional, for OCR)* a `llama.cpp` server running a vision/OCR model — see the `[llama]` section of `config.toml`.

## First-time setup

```powershell
cd audiocpp-ui
copy config.example.toml config.toml    # then edit paths / OCR models for your machine
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
.\scripts\build.bat          # installs frontend deps, builds, copies to backend/static
```

`config.toml` is **gitignored** (it holds machine-specific paths); `config.example.toml` is the committed template. A `data/config.toml` (also gitignored) overrides the root file if present.

## Run

From **VS Code**: open this folder and run a task (Terminal → Run Task) — **Build Frontend**, **Launch Desktop**, **Launch Browser**, or the combined **Build + Launch Desktop**.

From a terminal:

```powershell
# native desktop window
.\.venv\Scripts\python backend\desktop_app.py

# or in your default browser
.\.venv\Scripts\python backend\browser_app.py
```

Both serve at `http://127.0.0.1:8110`. Tabs: **Text to Speech**, **Transcribe**, **Saved Voices**, **Library**, **OCR**, **Telemetry**. Click **Start** to launch the inference server.

## Dev workflow (hot reload)

Run the backend and the Vite dev server separately:

```powershell
# terminal 1 — API with auto-reload (VS Code: "Python Debugger: FastAPI")
.\.venv\Scripts\python -m uvicorn main:app --reload   # cwd: backend

# terminal 2 — Vite dev server (proxies /api → :8110)
cd frontend && npm run dev                            # open http://localhost:5173
```

The frontend build (`vite build`) does **not** type-check — run `cd frontend; npx tsc --noEmit` before building.

## Configuration (`config.toml`)

```toml
[server]                     # the FastAPI app that serves this UI
host = "0.0.0.0"             # 0.0.0.0 so the Android app can reach it on the LAN
port = 8110

[audiocpp]                   # the audio.cpp server this app launches and controls
exe = "E:/LLM/audio/audio.cpp/build/windows-cuda-release/bin/audiocpp_server.exe"
models_dir = "E:/LLM/audio/audio.cpp/models"
host = "127.0.0.1"
port = 9090

[llama]                      # external llama.cpp vision server for OCR (not launched here)
host = "127.0.0.1"
port = 8080
default_ocr_model = "paddleocr-vl-1-6-gguf"

# One [[llama.ocr_model]] per selectable OCR model. `model` is the name llama.cpp
# knows it by; the prompt + request-shaping differ per family (PaddleOCR-VL wants
# the literal prompt "OCR:"; Gemma wants an instruction prompt with thinking off).
[[llama.ocr_model]]
id = "paddleocr-vl-1-6-gguf"
label = "PaddleOCR-VL 1.6"
model = "paddleocr-vl-1-6-gguf"
prompt = "OCR:"
```

Copy `config.example.toml` → `config.toml` and edit `[audiocpp].exe`/`models_dir` and the OCR profiles for your machine. `config.toml` is gitignored; a `data/config.toml` (also gitignored) **overrides** the root file if present.

Optional icons: drop `icon_small.png` + `icon_large.png` in `backend/icons/` to brand the desktop window.

## Notes / limitations

- Reference and ASR **file uploads** are **WAV** only; the **Record mic** option converts to WAV automatically. In the desktop window the app auto-allows the microphone; in the browser you get the normal one-time prompt.
- `audiocpp_server` is **CUDA-only** and runs models **offline** (no streaming); requests are one-shot. Lazy-loaded models stay in VRAM until you **Stop** the server (or close the app).
- **OCR** requires a separate `llama.cpp` server (it is *not* launched by Studio). The **OCR** tab is a test bench to compare models/prompts on a dropped image.
- This is a **local, unauthenticated LAN tool** — do not expose the port beyond your own network. Generated audio, uploads, saved voices, and readings live under `backend/` and are **not** committed (see `.gitignore`).

## Troubleshooting

- **"Frontend not built"** — run `scripts\build.bat`.
- **"audiocpp_server not found"** — fix `[audiocpp] exe` in `config.toml`.
- **OCR errors / "OCR server unreachable"** — start your `llama.cpp` server and check `[llama]` host/port + model names.
- **Blank desktop window** — install/repair the WebView2 runtime.
- **Port in use** — change `[server] port` in `config.toml` (and the Vite proxy target in `frontend/vite.config.ts` for dev).
