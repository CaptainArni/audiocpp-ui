"""
audio.cpp Studio - FastAPI backend.

Serves the built React SPA and exposes /api/* that manages the audiocpp_server
process (start/stop/logs), scans downloaded models, saves uploaded reference
clips, and proxies TTS/ASR requests to the running audiocpp_server.
"""

import asyncio
import io
import json
import mimetypes
import threading
import time
import uuid
import wave
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from config import AppConfig
from logbus import log_bus
from metrics import metrics
from models import scan_models
from ocr import OCR_PROMPT, transcribe_image
from process import server_manager
from proxy import AudiocppError, registered_models, speech, transcribe

# Windows serves .js as text/plain by default, which breaks ES module loading.
mimetypes.add_type("application/javascript", ".js")

cfg = AppConfig.get()

_NO_STORE = {"Cache-Control": "no-store, must-revalidate"}

# High-frequency polling endpoints — kept out of the log viewer so it stays
# readable (the SPA hits /status every 2s, /logs holds an open SSE stream).
_QUIET_PATHS = {"/api/server/status", "/api/server/logs", "/api/server/registered"}


def _autostart_server():
    """Start audiocpp_server with all known models when the app launches."""
    try:
        if server_manager.state != "stopped":
            return
        selected = [m for m in scan_models() if m["family"] and m["task"]]
        if not selected:
            log_bus.emit("warn", "autostart skipped: no usable models found")
            return
        log_bus.emit("info", "auto-starting audiocpp_server ([audiocpp].autostart=false disables this)")
        server_manager.start(selected)
    except Exception as e:
        log_bus.emit("warn", f"autostart failed: {e}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Worker threads (child-process readers, health poll, endpoints) push log
    # lines into the SSE queues via this loop.
    log_bus.set_loop(asyncio.get_running_loop())
    log_bus.emit("info", "audio.cpp Studio backend ready")
    if cfg.audiocpp_autostart:
        threading.Thread(target=_autostart_server, daemon=True).start()
    yield
    # Make sure we don't leave audiocpp_server running when the app exits.
    server_manager.stop()


class AccessLogMiddleware:
    """Log every API request (method, path, status, duration) except pollers.

    A pure-ASGI middleware (not BaseHTTPMiddleware) so it never buffers response
    bodies — the /api/server/logs SSE stream must keep flowing chunk by chunk.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/") or path in _QUIET_PATHS:
            return await self.app(scope, receive, send)

        method = scope.get("method", "?")
        started = time.perf_counter()
        status = 500

        async def send_wrapper(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as e:
            log_bus.emit("error", f"{method} {path} → unhandled: {e}")
            raise
        ms = (time.perf_counter() - started) * 1000
        level = "warn" if status >= 400 else "debug"
        log_bus.emit(level, f"{method} {path} → {status} in {ms:.0f} ms")


app = FastAPI(title="audio.cpp Studio", lifespan=lifespan)
app.add_middleware(AccessLogMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.get_all_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _fail(err: Exception) -> JSONResponse:
    status = 502 if isinstance(err, AudiocppError) else 400
    return JSONResponse(status_code=status, content={"error": str(err)})


def _wav_duration(data: bytes) -> "float | None":
    """Duration in seconds of a WAV byte string, or None if it can't be read."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            rate = w.getframerate()
            return w.getnframes() / rate if rate else None
    except Exception:
        return None


def _upload_path(upload_id: str) -> str:
    p = (cfg.uploads_dir / upload_id).resolve()
    if cfg.uploads_dir.resolve() not in p.parents or not p.exists():
        raise ValueError(f"upload not found: {upload_id}")
    return str(p)


def _voice_paths(voice_id: str) -> "tuple[Path, Path]":
    """(clip.wav, meta.json) for a saved voice id, traversal-checked."""
    wav = (cfg.voices_dir / f"{voice_id}.wav").resolve()
    if cfg.voices_dir.resolve() not in wav.parents:
        raise ValueError(f"invalid voice id: {voice_id}")
    return wav, wav.with_suffix(".json")


def _load_voice(voice_id: str) -> dict:
    wav, meta_path = _voice_paths(voice_id)
    if not wav.exists() or not meta_path.exists():
        raise ValueError(f"saved voice not found: {voice_id}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["id"] = voice_id
    meta["path"] = str(wav)
    return meta


# --- model discovery -------------------------------------------------------
@app.get("/api/models")
async def api_models():
    return {"models": scan_models()}


# --- server lifecycle ------------------------------------------------------
@app.get("/api/server/status")
async def api_status():
    return server_manager.status()


@app.post("/api/server/start")
async def api_start(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    requested = body.get("modelIds")
    selected = [m for m in scan_models() if m["family"] and m["task"]]
    if isinstance(requested, list) and requested:
        selected = [m for m in selected if m["id"] in requested]
    try:
        server_manager.start(selected)
    except Exception as e:
        return _fail(e)
    # The freshly (re)started server has nothing loaded yet — mark models cold.
    metrics.on_server_start()
    return server_manager.status()


@app.post("/api/server/stop")
async def api_stop():
    try:
        server_manager.stop()
    except Exception as e:
        return _fail(e)
    return server_manager.status()


@app.get("/api/server/logs")
async def api_logs():
    q: asyncio.Queue = asyncio.Queue()
    log_bus.add_subscriber(q)

    async def gen():
        try:
            yield ": connected\n\n"
            for entry in log_bus.snapshot():
                yield f"data: {json.dumps(entry)}\n\n"
            while True:
                entry = await q.get()
                yield f"data: {json.dumps(entry)}\n\n"
        finally:
            log_bus.remove_subscriber(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform"},
    )


@app.get("/api/server/registered")
async def api_registered():
    if server_manager.status()["state"] != "running":
        return {"models": []}
    try:
        return {"models": await registered_models()}
    except Exception as e:
        return _fail(e)


@app.get("/api/telemetry")
async def api_telemetry():
    """Server state + per-model warm/throughput stats and recent generations."""
    return {"server": server_manager.status(), "metrics": metrics.snapshot()}


# --- uploads (reference clips / ASR audio) ---------------------------------
@app.post("/api/uploads")
async def api_upload(file: UploadFile = File(...)):
    orig = file.filename or "upload.wav"
    if not orig.lower().endswith(".wav"):
        log_bus.emit("warn", f"upload rejected (not a .wav): {orig}")
        return JSONResponse(status_code=400, content={"error": "only .wav files are supported in this version"})
    upload_id = f"{uuid.uuid4().hex}.wav"
    data = await file.read()
    (cfg.uploads_dir / upload_id).write_bytes(data)
    log_bus.emit("info", f"upload saved · {orig} → {upload_id} ({len(data) // 1024} KB)")
    return {"uploadId": upload_id, "path": str((cfg.uploads_dir / upload_id).resolve()), "originalName": orig}


@app.get("/api/uploads/{upload_id}/audio")
async def api_upload_audio(upload_id: str):
    try:
        p = _upload_path(upload_id)
    except ValueError:
        return JSONResponse(status_code=404, content={"error": "upload not found"})
    return FileResponse(p, media_type="audio/wav")


# --- saved voices (reference clip + transcript, reusable across sessions) ---
@app.get("/api/voices")
async def api_voices():
    voices = []
    for meta_path in cfg.voices_dir.glob("*.json"):
        wav = meta_path.with_suffix(".wav")
        if not wav.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        voices.append(
            {
                "id": meta_path.stem,
                "name": meta.get("name") or meta_path.stem,
                "referenceText": meta.get("referenceText") or "",
                "createdAt": meta.get("createdAt") or meta_path.stat().st_mtime * 1000,
                "sizeKB": round(wav.stat().st_size / 1024),
                "durationSec": _wav_duration(wav.read_bytes()),
            }
        )
    voices.sort(key=lambda v: v["createdAt"], reverse=True)
    return {"voices": voices}


@app.post("/api/voices")
async def api_save_voice(request: Request):
    try:
        body = await request.json()
        name = str(body.get("name") or "").strip()
        if not name:
            raise ValueError("a name for the voice is required")
        upload_id = body.get("uploadId")
        if not upload_id:
            raise ValueError("an uploaded reference clip is required")
        src = Path(_upload_path(upload_id))

        voice_id = uuid.uuid4().hex
        wav, meta_path = _voice_paths(voice_id)
        wav.write_bytes(src.read_bytes())
        meta = {
            "name": name,
            "referenceText": str(body.get("referenceText") or ""),
            "createdAt": time.time() * 1000,
        }
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        log_bus.emit("success", f"voice saved · \"{name}\" ({voice_id})")
        return {"id": voice_id, **meta}
    except Exception as e:
        log_bus.emit("error", f"saving voice failed: {e}")
        return _fail(e)


@app.delete("/api/voices/{voice_id}")
async def api_delete_voice(voice_id: str):
    try:
        wav, meta_path = _voice_paths(voice_id)
        if not wav.exists() and not meta_path.exists():
            return JSONResponse(status_code=404, content={"error": "voice not found"})
        wav.unlink(missing_ok=True)
        meta_path.unlink(missing_ok=True)
        log_bus.emit("info", f"voice deleted · {voice_id}")
        return {"ok": True}
    except Exception as e:
        return _fail(e)


@app.put("/api/voices/{voice_id}")
async def api_update_voice(voice_id: str, request: Request):
    """Rename a saved voice. Only the display name is editable here."""
    try:
        try:
            _, meta_path = _voice_paths(voice_id)
        except ValueError:
            return JSONResponse(status_code=404, content={"error": "voice not found"})
        if not meta_path.exists():
            return JSONResponse(status_code=404, content={"error": "voice not found"})
        body = await request.json()
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if "name" in body:
            name = str(body.get("name") or "").strip()
            if not name:
                raise ValueError("name cannot be empty")
            meta["name"] = name
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        log_bus.emit("info", f"voice renamed · {voice_id} → \"{meta.get('name')}\"")
        return {"id": voice_id, **meta}
    except Exception as e:
        log_bus.emit("error", f"renaming voice failed: {e}")
        return _fail(e)


@app.get("/api/voices/{voice_id}/audio")
async def api_voice_audio(voice_id: str):
    try:
        wav, _ = _voice_paths(voice_id)
    except ValueError:
        return JSONResponse(status_code=404, content={"error": "voice not found"})
    if not wav.exists():
        return JSONResponse(status_code=404, content={"error": "voice not found"})
    return FileResponse(wav, media_type="audio/wav")


# --- TTS / cloning ---------------------------------------------------------
@app.post("/api/tts")
async def api_tts(request: Request):
    try:
        body = await request.json()
        model = body.get("model")
        text = body.get("text")
        if not model:
            raise ValueError("model is required")
        if not text or not str(text).strip():
            raise ValueError("text is required")

        req: dict = {"model": model, "input": text, "response_format": "wav"}
        if body.get("language"):
            req["language"] = body["language"]
        if body.get("voiceId"):
            req["voice"] = body["voiceId"]
        if body.get("savedVoiceId"):
            saved = _load_voice(body["savedVoiceId"])
            req["voice_ref"] = saved["path"]
            if saved.get("referenceText"):
                req["reference_text"] = saved["referenceText"]
        elif body.get("uploadId"):
            req["voice_ref"] = _upload_path(body["uploadId"])
        if body.get("referenceText"):
            req["reference_text"] = body["referenceText"]
        if body.get("instructions"):
            req["instructions"] = body["instructions"]
        params = body.get("params")
        if isinstance(params, dict):
            for k, v in params.items():
                if v is not None and v != "":
                    req[k] = v

        summary = [f"model={model}"]
        if body.get("voiceId"):
            summary.append(f"voice={body['voiceId']}")
        if body.get("savedVoiceId"):
            summary.append("clone(saved)")
        elif body.get("uploadId"):
            summary.append("clone")
        if body.get("language"):
            summary.append(f"lang={body['language']}")
        if body.get("instructions"):
            summary.append("voice-design")
        if isinstance(params, dict):
            extra = [k for k, v in params.items() if v is not None and v != ""]
            if extra:
                summary.append("params=" + ",".join(extra))
        summary.append(f"text={len(str(text))} chars")
        log_bus.emit("info", "TTS request · " + " · ".join(summary))

        t0 = time.perf_counter()
        wav = await speech(req)
        wall = time.perf_counter() - t0
        name = f"tts-{int(time.time() * 1000)}.wav"
        (cfg.generated_dir / name).write_bytes(wav)
        dur = _wav_duration(wav)
        dur_txt = f" · {dur:.2f}s" if dur is not None else ""
        log_bus.emit(
            "success",
            f"TTS done · {name} · {len(wav) // 1024} KB{dur_txt} in {wall:.2f}s",
        )
        # Realtime factor: seconds of audio produced per wall-clock second.
        rtf = (dur / wall) if (dur is not None and wall > 0) else None
        metrics.record(
            model, "tts", wall * 1000, throughput=rtf, unit="× realtime",
            detail=(f"{dur:.1f}s audio" if dur is not None else f"{len(str(text))} chars"),
        )
        if dur is not None and dur < 0.5:
            log_bus.emit("warn", f"TTS output is near-empty ({dur:.2f}s) — the model likely returned an empty sample")
        return Response(content=wav, media_type="audio/wav", headers={"X-Generation-Name": name})
    except Exception as e:
        log_bus.emit("error", f"TTS failed: {e}")
        return _fail(e)


# --- ASR -------------------------------------------------------------------
@app.post("/api/transcribe")
async def api_transcribe(request: Request):
    try:
        body = await request.json()
        model = body.get("model")
        upload_id = body.get("uploadId")
        if not model:
            raise ValueError("model is required")
        if not upload_id:
            raise ValueError("an uploaded audio file is required")
        audio_path = _upload_path(upload_id)
        req: dict = {"model": model, "audio": audio_path}
        if body.get("language"):
            req["language"] = body["language"]
        want_timestamps = bool(body.get("timestamps"))
        if want_timestamps:
            req["options"] = {"return_timestamps": "true"}
        lang = f" · lang={body['language']}" if body.get("language") else ""
        ts = " · timestamps" if want_timestamps else ""
        log_bus.emit("info", f"ASR request · model={model} · file={upload_id}{lang}{ts}")
        t0 = time.perf_counter()
        result = await transcribe(req)
        asr_wall = time.perf_counter() - t0
        text = result.get("text", "")
        metrics.record(model, "asr", asr_wall * 1000, detail=f"{len(text)} chars")

        # Upstream word spans are in samples of the input audio; convert to
        # seconds using the uploaded WAV's own sample rate.
        words = []
        raw_words = result.get("words") or []
        if raw_words:
            try:
                with wave.open(audio_path, "rb") as w:
                    rate = w.getframerate()
            except Exception:
                rate = 0
            if rate > 0:
                words = [
                    {
                        "word": rw.get("word", ""),
                        "start": rw.get("start_sample", 0) / rate,
                        "end": rw.get("end_sample", 0) / rate,
                    }
                    for rw in raw_words
                ]

        word_txt = f" · {len(words)} timed words" if words else ""
        log_bus.emit("success", f"ASR done · {len(text)} chars{word_txt} in {time.perf_counter() - t0:.2f}s")
        return {"text": text, "language": result.get("language"), "words": words}
    except Exception as e:
        log_bus.emit("error", f"ASR failed: {e}")
        return _fail(e)


# --- OCR (page photo -> text, for the Android companion app) ----------------
@app.get("/api/ocr/models")
async def api_ocr_models():
    """Selectable OCR models + which id is the default (for the app's dropdown
    and Studio's OCR test bench). `prompt` is the effective default prompt."""
    cfg = AppConfig.get()
    return {
        "models": [
            {"id": m["id"], "label": m["label"], "prompt": m.get("prompt") or OCR_PROMPT}
            for m in cfg.llama_ocr_models
        ],
        "default": cfg.llama_default_ocr_model,
    }


@app.post("/api/ocr")
async def api_ocr(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    prompt: str | None = Form(None),
):
    try:
        mime = file.content_type or ""
        if not mime.startswith("image/"):
            return JSONResponse(status_code=400, content={"error": "an image file is required"})
        data = await file.read()
        if not data:
            return JSONResponse(status_code=400, content={"error": "the uploaded image is empty"})
        return await transcribe_image(data, mime, prompt=(prompt or None), model_id=model or None)
    except Exception as e:
        log_bus.emit("error", f"OCR failed: {e}")
        return _fail(e)


# --- saved readings (named sets of page texts, for the Android app) ---------
def _reading_path(reading_id: str) -> Path:
    """Resolve a reading file, rejecting any id that escapes readings_dir."""
    p = (cfg.readings_dir / f"{reading_id}.json").resolve()
    if p.parent != cfg.readings_dir.resolve():
        raise ValueError("invalid reading id")
    return p


def _load_reading(reading_id: str) -> dict:
    p = _reading_path(reading_id)
    if not p.exists():
        raise FileNotFoundError("reading not found")
    return json.loads(p.read_text(encoding="utf-8"))


def _clean_pages(raw) -> list[str]:
    if not isinstance(raw, list):
        raise ValueError("pages must be a list of strings")
    pages = [str(p) for p in raw if str(p).strip()]
    if not pages:
        raise ValueError("a reading needs at least one non-empty page")
    return pages


@app.get("/api/readings")
async def api_readings():
    """List saved readings as summaries (no page bodies), newest first."""
    items = []
    for p in cfg.readings_dir.glob("*.json"):
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pages = r.get("pages") or []
        items.append(
            {
                "id": p.stem,
                "name": r.get("name") or p.stem,
                "pageCount": len(pages),
                "lastVoiceId": r.get("lastVoiceId"),
                "createdAt": r.get("createdAt") or p.stat().st_mtime * 1000,
                "updatedAt": r.get("updatedAt") or p.stat().st_mtime * 1000,
            }
        )
    items.sort(key=lambda r: r["updatedAt"], reverse=True)
    return {"readings": items}


@app.get("/api/readings/{reading_id}")
async def api_reading(reading_id: str):
    try:
        r = _load_reading(reading_id)
    except (ValueError, FileNotFoundError):
        return JSONResponse(status_code=404, content={"error": "reading not found"})
    return {"id": reading_id, **r}


@app.post("/api/readings")
async def api_create_reading(request: Request):
    try:
        body = await request.json()
        name = str(body.get("name") or "").strip()
        if not name:
            raise ValueError("a name for the reading is required")
        pages = _clean_pages(body.get("pages"))
        now = time.time() * 1000
        reading_id = uuid.uuid4().hex
        doc = {
            "name": name,
            "pages": pages,
            "lastVoiceId": body.get("lastVoiceId") or None,
            "createdAt": now,
            "updatedAt": now,
        }
        _reading_path(reading_id).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        log_bus.emit("success", f'reading saved · "{name}" ({len(pages)} pages, {reading_id})')
        return {"id": reading_id, **doc}
    except Exception as e:
        log_bus.emit("error", f"saving reading failed: {e}")
        return _fail(e)


@app.put("/api/readings/{reading_id}")
async def api_update_reading(reading_id: str, request: Request):
    """Update a reading in place. Any of name / pages / lastVoiceId may be sent."""
    try:
        try:
            doc = _load_reading(reading_id)
        except (ValueError, FileNotFoundError):
            return JSONResponse(status_code=404, content={"error": "reading not found"})
        body = await request.json()
        if "name" in body:
            name = str(body.get("name") or "").strip()
            if not name:
                raise ValueError("name cannot be empty")
            doc["name"] = name
        if "pages" in body:
            doc["pages"] = _clean_pages(body.get("pages"))
        if "lastVoiceId" in body:
            doc["lastVoiceId"] = body.get("lastVoiceId") or None
        doc["updatedAt"] = time.time() * 1000
        _reading_path(reading_id).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"id": reading_id, **doc}
    except Exception as e:
        log_bus.emit("error", f"updating reading failed: {e}")
        return _fail(e)


@app.delete("/api/readings/{reading_id}")
async def api_delete_reading(reading_id: str):
    try:
        p = _reading_path(reading_id)
    except ValueError:
        return JSONResponse(status_code=404, content={"error": "reading not found"})
    if not p.exists():
        return JSONResponse(status_code=404, content={"error": "reading not found"})
    p.unlink(missing_ok=True)
    log_bus.emit("info", f"reading deleted · {reading_id}")
    return {"ok": True}


# --- generation history ----------------------------------------------------
@app.get("/api/generations")
async def api_generations():
    gens = []
    for p in cfg.generated_dir.glob("*.wav"):
        st = p.stat()
        gens.append(
            {
                "name": p.name,
                "url": f"/api/generations/{p.name}",
                "sizeKB": round(st.st_size / 1024),
                "mtime": st.st_mtime * 1000,
            }
        )
    gens.sort(key=lambda g: g["mtime"], reverse=True)
    return {"generations": gens}


@app.delete("/api/generations")
async def api_clear_generations():
    # Only wipe generated audio; server.json also lives here and must survive.
    removed = 0
    for p in cfg.generated_dir.glob("*.wav"):
        try:
            p.unlink()
            removed += 1
        except OSError:
            pass
    log_bus.emit("info", f"cleared {removed} generation(s)")
    return {"removed": removed}


@app.get("/api/generations/{name}")
async def api_generation(name: str):
    p = (cfg.generated_dir / name).resolve()
    if cfg.generated_dir.resolve() not in p.parents or not p.exists():
        return JSONResponse(status_code=404, content={"error": "not found"})
    return FileResponse(p)


# --- static SPA (must be registered last) ----------------------------------
if cfg.static_dir.exists() and (cfg.static_dir / "assets").exists():
    # Hashed /assets bundles are safe to cache; only index.html gets no-store.
    app.mount("/assets", StaticFiles(directory=str(cfg.static_dir / "assets")), name="assets")


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    static_dir = cfg.static_dir
    static_file = static_dir / full_path
    if (
        full_path
        and ".." not in full_path
        and static_file.is_file()
        and static_dir.resolve() in static_file.resolve().parents
    ):
        if static_file.name == "index.html":
            return FileResponse(static_file, headers=_NO_STORE)
        return FileResponse(static_file)
    index_file = static_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, headers=_NO_STORE)
    return JSONResponse(status_code=200, content={"error": "Frontend not built. Run scripts/build.bat first."})
