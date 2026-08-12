"""
audio.cpp Studio - FastAPI backend.

Serves the built React SPA and exposes /api/* that manages the audiocpp_server
process (start/stop/logs), scans downloaded models, saves uploaded reference
clips, and proxies TTS/ASR requests to the running audiocpp_server.
"""

import asyncio
import base64
import io
import json
import mimetypes
import re
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

import chat
import media
from catalog import lookup_catalog
from config import AppConfig
from logbus import log_bus
from metrics import metrics
from models import scan_models
from ocr import OCR_PROMPT, transcribe_image
from process import server_manager
from proxy import (
    STREAM_SAMPLE_RATE,
    AudiocppError,
    registered_models,
    speech,
    speech_stream,
    transcribe,
    unload_models,
)

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
    if media.ffmpeg_path():
        log_bus.emit("debug", f"ffmpeg available · {media.ffmpeg_version()}")
    else:
        log_bus.emit("warn", "ffmpeg not found — uploads are limited to .wav (see [media] in config.toml)")
    media.prune_uploads()
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


def _wav_duration_of(path: Path) -> "float | None":
    """Duration of a WAV on disk, without reading it into memory (they get big)."""
    try:
        with wave.open(str(path), "rb") as w:
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


@app.post("/api/server/unload")
async def api_unload(request: Request):
    """Free VRAM: drop loaded models. Body `{modelIds: [...]}`, or all if absent.

    Models load lazily and are then held forever, which is right for latency and
    wrong for a box that also runs a 27B chat model — before this the only way
    out of that corner was restarting the whole audio server.
    """
    if server_manager.status()["state"] != "running":
        return _fail(ValueError("the audio server is not running"))
    try:
        body = await request.json()
    except Exception:
        body = {}
    ids = body.get("modelIds") or None
    if ids is not None and not isinstance(ids, list):
        return _fail(ValueError("modelIds must be a list of model ids"))
    try:
        result = await unload_models([str(i) for i in ids] if ids else None)
    except Exception as e:
        return _fail(e)
    metrics.on_unloaded(result.get("unloaded") or [])
    return result


# --- uploads (reference clips / ASR audio / video) -------------------------
async def _spool(file: UploadFile, dest: Path) -> int:
    """Stream an upload to disk in chunks, enforcing [media].max_upload_mb.

    Deliberately not `await file.read()`: a video is uploaded whole (only its
    audio survives the conversion) and must never be held in memory.
    """
    limit = cfg.media_max_upload_mb * 1024 * 1024
    written = 0
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            written += len(chunk)
            if written > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise ValueError(f"file is larger than the {cfg.media_max_upload_mb} MB upload limit")
            out.write(chunk)
    return written


@app.post("/api/uploads")
async def api_upload(file: UploadFile = File(...), rate: int | None = Form(None)):
    """Accept any audio or video file; store it as a WAV and return its id.

    A .wav with no explicit `rate` is stored untouched (the reference-clip path).
    Anything else — mp3, m4a, a phone recording, a whole .mkv — is probed and
    transcoded by ffmpeg to mono 16-bit PCM at `rate` (ASR callers ask for 16000,
    which is what the server's VAD chunking expects).
    """
    orig = file.filename or "upload.wav"
    suffix = Path(orig).suffix.lower()[:12] or ".bin"
    is_wav = suffix == ".wav"

    # Passthrough: a WAV that nobody asked us to resample is already the target
    # format, so it costs nothing and needs no ffmpeg.
    if is_wav and not rate:
        upload_id = f"{uuid.uuid4().hex}.wav"
        dest = cfg.uploads_dir / upload_id
        try:
            size = await _spool(file, dest)
        except ValueError as e:
            return _fail(e)
        log_bus.emit("info", f"upload saved · {orig} → {upload_id} ({size // 1024} KB)")
        media.prune_uploads()
        return {
            "uploadId": upload_id,
            "path": str(dest.resolve()),
            "originalName": orig,
            "durationSec": _wav_duration_of(dest),
            "converted": False,
            "sourceKind": "wav",
        }

    staged = cfg.uploads_dir / f"{uuid.uuid4().hex}.src{suffix}"
    upload_id = f"{uuid.uuid4().hex}.wav"
    dest = cfg.uploads_dir / upload_id
    try:
        size = await _spool(file, staged)
        info = media.probe(staged)
        if not info["hasAudio"]:
            raise ValueError(f'"{orig}" has no audio track')
        duration = info["durationSec"]
        if duration and duration > cfg.media_max_duration_sec:
            fmt = lambda s: f"{s / 60:.0f} min" if s >= 60 else f"{s:.0f}s"  # noqa: E731
            raise ValueError(
                f"{orig} is {fmt(duration)} long, over the {fmt(cfg.media_max_duration_sec)} "
                f"limit ([media].max_duration_sec)"
            )
        kind = "video" if info["hasVideo"] else "audio"
        log_bus.emit(
            "info",
            f"upload · {orig} ({size // 1024} KB, {kind}/{info['format']}"
            f"{f', {duration:.1f}s' if duration else ''}) → extracting audio",
        )
        media.to_wav(staged, dest, rate=rate or 16000)
    except Exception as e:
        dest.unlink(missing_ok=True)
        log_bus.emit("warn", f"upload rejected · {orig}: {e}")
        return _fail(e)
    finally:
        staged.unlink(missing_ok=True)

    media.prune_uploads()
    return {
        "uploadId": upload_id,
        "path": str(dest.resolve()),
        "originalName": orig,
        "durationSec": _wav_duration_of(dest),
        "converted": True,
        "sourceKind": kind,
    }


@app.get("/api/media/support")
async def api_media_support():
    """Whether ffmpeg is available, and the upload limits — so the clients can
    offer (or explain away) the video/audio file picker before anything is sent."""
    return media.support()


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
def _speech_request(body: dict) -> "tuple[dict, int | None]":
    """Build the upstream /v1/audio/speech body from an /api/tts-shaped payload.

    Shared with /api/call/speak so a call resolves voices — built-in, saved clone,
    freshly uploaded clip — exactly like the TTS panel does. Returns the request
    and the auto-derived token budget (None when the caller set max_tokens).
    """
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

    # Size the AR token budget to the text so a run-away generation (one
    # that never emits its stop token) fails in seconds instead of running
    # to the model-wide ceiling in server.json. An explicit max_tokens from
    # the params panel always wins.
    budget = None
    if "max_tokens" not in req:
        entry = lookup_catalog(str(model).split("@", 1)[0])
        if entry is not None and entry.token_budget is not None:
            budget = entry.token_budget.for_text(len(str(text)))
            req["max_tokens"] = budget
    return req, budget


@app.post("/api/tts")
async def api_tts(request: Request):
    try:
        body = await request.json()
        model = body.get("model")
        text = body.get("text")
        req, budget = _speech_request(body)
        params = body.get("params")

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
        if budget is not None:
            summary.append(f"max_tokens={budget} (auto)")
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


# --- voice call (mic -> ASR -> llama.cpp chat -> streamed TTS) --------------
def _model_streams(model_id: str) -> bool:
    """Whether this model was registered `mode: "streaming"` (see serverjson.py)."""
    entry = lookup_catalog(str(model_id).split("@", 1)[0])
    return bool(entry and entry.streaming)


# A streaming ASR session consumes audio in fixed windows ("preferred chunk size
# is one second at the model sample rate") and discards whatever is left over at
# the end. Measured on Nemotron: a 4.6 s turn ending "…und ein paar Eier da"
# transcribed as "…und ein paar" — the last words silently gone, which in a
# conversation means the model answers a question it never heard in full. One
# second of trailing silence flushes that final window. Offline models don't
# need it and don't care (at RTF 0.03 it costs ~30 ms), so it is unconditional
# rather than conditional on a model flag nobody will remember to set.
_ASR_TAIL_PAD_SEC = 1.0


def _pad_wav_tail(path: Path, seconds: float = _ASR_TAIL_PAD_SEC) -> None:
    """Append silence to a mono 16-bit WAV in place."""
    try:
        with wave.open(str(path), "rb") as w:
            params = w.getparams()
            frames = w.readframes(w.getnframes())
        pad = b"\x00" * int(params.framerate * seconds) * params.sampwidth * params.nchannels
        with wave.open(str(path), "wb") as w:
            w.setparams(params)
            w.writeframes(frames + pad)
    except Exception as e:
        # Padding is a safeguard, not a requirement — a WAV we can't rewrite
        # should still be transcribed.
        log_bus.emit("debug", f"could not pad utterance tail: {e}")


@app.get("/api/call/config")
async def api_call_config():
    """Everything a call client needs before the first turn: the models it may
    pick, the length presets, and the turn-taking defaults. One request instead
    of the clients hardcoding a copy each."""
    cfg = AppConfig.get()
    try:
        chat_models = await chat.list_models()
        chat_error = None
    except Exception as e:
        # A missing llama.cpp must not stop the tab from rendering — it should
        # render and say what to start.
        chat_models, chat_error = [], str(e)
    return {
        "chatModels": chat_models,
        "chatError": chat_error,
        "defaultChatModel": cfg.call_default_chat_model,
        "defaultTtsModel": cfg.call_default_tts_model,
        "defaultAsrModel": cfg.call_default_asr_model,
        "lengths": cfg.call_lengths,
        "defaultLength": cfg.call_default_length,
        "systemPrompt": cfg.call_system_prompt,
        "vadHangoverMs": cfg.call_vad_hangover_ms,
        "vadPrerollMs": cfg.call_vad_preroll_ms,
        "fillerAfterMs": cfg.call_filler_after_ms,
        "fillerText": cfg.call_filler_text,
        "streamSampleRate": STREAM_SAMPLE_RATE,
    }


@app.post("/api/chat")
async def api_chat(request: Request):
    """Stream one assistant turn as SSE.

    Events: `{type:"reasoning"|"text", delta}` while tokens arrive,
    `{type:"speak", index, text}` per ready-to-synthesise segment,
    `{type:"done", …}`, `{type:"error", message}`. Errors are events rather than
    HTTP statuses because the stream has already sent its headers by then.
    """
    cfg = AppConfig.get()
    try:
        body = await request.json()
    except Exception:
        return _fail(ValueError("a JSON body is required"))

    model = body.get("model") or cfg.call_default_chat_model
    if not model:
        return _fail(ValueError("model is required (no [call].default_chat_model configured)"))
    history = body.get("messages")
    if not isinstance(history, list) or not history:
        return _fail(ValueError("messages is required"))

    length = cfg.call_length_by_id(body.get("length"))
    thinking = bool(body.get("thinking"))
    max_tokens = int(body.get("maxTokens") or (length or {}).get("max_tokens") or 400)
    # Reasoning is spent from the same budget as the answer, so a short preset
    # with thinking on would run out mid-thought and never speak a word.
    if thinking:
        max_tokens += cfg.call_thinking_tokens
    system_prompt = body.get("systemPrompt")
    if system_prompt is None:
        system_prompt = cfg.call_system_prompt
    # Only the most recent turns are resent; the system prompt is always kept.
    trimmed = history[-cfg.call_context_messages :]
    dropped = len(history) - len(trimmed)
    messages = chat.build_messages(trimmed, system_prompt, (length or {}).get("instruction", ""))

    async def gen():
        # Say what was left out. Trimming used to be silent, so twenty turns in
        # the assistant simply stopped knowing how the conversation started and
        # nothing on screen explained why — the caller blames the model.
        if dropped:
            yield f"data: {json.dumps({'type': 'context', 'dropped': dropped, 'kept': len(trimmed)})}\n\n"
        try:
            async for event in chat.stream_chat(
                model, messages, thinking=thinking, max_tokens=max_tokens
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            log_bus.emit("error", f"chat failed: {e}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.post("/api/call/listen")
async def api_call_listen(
    file: UploadFile = File(...),
    model: str = Form(...),
    language: str | None = Form(None),
):
    """One turn of speech in, transcript out — upload and ASR fused.

    /api/uploads + /api/transcribe would do the same in two round trips. A turn
    is a couple of seconds of 16 kHz mono, so the saving is the RTT, which is
    exactly the kind of latency a conversation notices (and the phone pays twice
    over a tunnel).
    """
    upload_id = f"{uuid.uuid4().hex}.wav"
    dest = cfg.uploads_dir / upload_id
    try:
        size = await _spool(file, dest)
        _pad_wav_tail(dest)
        t0 = time.perf_counter()
        result = await transcribe({"model": model, "audio": str(dest.resolve()), **({"language": language} if language else {})})
        wall = time.perf_counter() - t0
        text = (result.get("text") or "").strip()
        metrics.record(model, "asr", wall * 1000, detail=f"{len(text)} chars")
        log_bus.emit(
            "info",
            f"call · heard {len(text)} chars from {size // 1024} KB in {wall:.2f}s"
            + ("" if text else " — nothing recognised"),
        )
        # An empty transcript is a normal outcome (a cough, a door), not an error:
        # the client shows "didn't catch that" and does not spend a turn.
        return {"text": text, "seconds": round(wall, 2)}
    except Exception as e:
        log_bus.emit("error", f"call listen failed: {e}")
        return _fail(e)
    finally:
        media.prune_uploads()


@app.post("/api/call/speak")
async def api_call_speak(request: Request):
    """Synthesise one segment and return it as raw PCM, streamed when possible.

    The response shape is identical either way — `audio/pcm`, chunked, with the
    format in headers — so a client has one playback path. Only the time to the
    first byte differs: a streaming-registered model starts sending while it is
    still generating, everything else renders the WAV first and sends it whole.
    """
    try:
        body = await request.json()
        req, _ = _speech_request(body)
    except Exception as e:
        return _fail(e)

    model = str(body.get("model"))
    headers = {
        "X-Sample-Rate": str(STREAM_SAMPLE_RATE),
        "X-Channels": "1",
        "X-Sample-Format": "s16le",
        "Cache-Control": "no-store",
    }

    if _model_streams(model):
        async def stream():
            # Timed here rather than in the proxy so both branches land in
            # telemetry the same way /api/tts does — otherwise every spoken
            # reply in a call would be invisible on the Telemetry tab.
            t0 = time.perf_counter()
            total = 0
            async for chunk in speech_stream(req):
                total += len(chunk)
                yield chunk
            wall = time.perf_counter() - t0
            seconds = total / 2 / STREAM_SAMPLE_RATE
            metrics.record(
                model, "tts", wall * 1000,
                throughput=(seconds / wall) if wall > 0 else None,
                unit="× realtime", detail=f"{seconds:.1f}s audio (stream)",
            )

        return StreamingResponse(stream(), media_type="audio/pcm", headers=headers)

    # Non-streaming model: render the whole clip, then hand over its PCM. The
    # WAV's own rate is what matters here, not the streaming contract.
    try:
        t0 = time.perf_counter()
        wav = await speech(req)
        wall = time.perf_counter() - t0
    except Exception as e:
        log_bus.emit("error", f"call speak failed: {e}")
        return _fail(e)
    pcm, rate = _wav_to_pcm(wav)
    duration = len(pcm) / 2 / rate if rate else None
    metrics.record(
        model, "tts", wall * 1000,
        throughput=(duration / wall) if (duration and wall > 0) else None,
        unit="× realtime", detail=f"{duration:.1f}s audio" if duration else "",
    )
    headers["X-Sample-Rate"] = str(rate)
    return Response(content=pcm, media_type="audio/pcm", headers=headers)


def _wav_to_pcm(data: bytes) -> "tuple[bytes, int]":
    """Strip a mono 16-bit WAV down to its raw frames + sample rate."""
    with wave.open(io.BytesIO(data), "rb") as w:
        return w.readframes(w.getnframes()), w.getframerate()


@app.post("/api/call/warmup")
async def api_call_warmup(request: Request):
    """Load every model a call needs before the first turn.

    Lazy loading means the first request to each model pays a full load into
    VRAM, and the server never unloads afterwards. Paying all of it here, behind
    a "warming up" state, is the difference between a first turn that takes half
    a minute and one that behaves like the rest.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    cfg_ = AppConfig.get()
    out: dict = {}

    async def timed(name: str, coro):
        t0 = time.perf_counter()
        try:
            await coro
            out[name] = round((time.perf_counter() - t0) * 1000)
        except Exception as e:
            out[name] = None
            out[f"{name}Error"] = str(e)

    tasks = []
    tts_model = body.get("ttsModel")
    if tts_model:
        # Synthesising the filler phrase warms the model *and* produces the clip
        # the client plays when a turn takes a moment — one request, both jobs.
        speak_body = {**body, "model": tts_model, "text": cfg_.call_filler_text}
        speak_body.pop("ttsModel", None)

        async def warm_tts():
            t0 = time.perf_counter()
            req, _ = _speech_request(speak_body)
            wav = await speech(req)
            # Recorded like any other generation: warm-up *is* a request, and
            # without this telemetry calls the model cold while it is sitting in
            # VRAM — which also greys out the Free VRAM button that would
            # release it.
            metrics.record(
                tts_model, "tts", (time.perf_counter() - t0) * 1000, detail="warm-up"
            )
            out["filler"] = base64.b64encode(wav).decode("ascii")

        tasks.append(timed("tts", warm_tts()))

    asr_model = body.get("asrModel")
    if asr_model:
        async def warm_asr():
            t0 = time.perf_counter()
            silence = cfg.uploads_dir / f"warmup-{uuid.uuid4().hex}.wav"
            try:
                with wave.open(str(silence), "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(16000)
                    # Must exceed one streaming window, or a streaming ASR model
                    # rejects it outright ("shorter than the first required chunk").
                    w.writeframes(b"\x00\x00" * 24000)  # 1.5 s
                await transcribe({"model": asr_model, "audio": str(silence.resolve())})
                metrics.record(
                    asr_model, "asr", (time.perf_counter() - t0) * 1000, detail="warm-up"
                )
            finally:
                silence.unlink(missing_ok=True)

        tasks.append(timed("asr", warm_asr()))

    chat_model = body.get("chatModel")
    if chat_model:
        async def warm_chat():
            # Also forces llama-swap to load this model now rather than on the
            # first real turn, where the swap would land inside the response time.
            async for _ in chat.stream_chat(
                chat_model, [{"role": "user", "content": "Hi"}], thinking=False, max_tokens=1
            ):
                pass

        tasks.append(timed("chat", warm_chat()))

    if tasks:
        await asyncio.gather(*tasks)
    log_bus.emit(
        "info",
        "call warm-up · "
        + " · ".join(f"{k} {v} ms" for k, v in out.items() if k in ("tts", "asr", "chat") and v is not None),
    )
    return out


@app.post("/api/call/turn")
async def api_call_turn(request: Request):
    """Record how long one completed turn took, end to end.

    A turn is a pipeline, not a model — ASR, then chat, then TTS, plus the
    caller's own pause — so it is recorded under its own name rather than
    against any one of the three. Telemetry already had each stage separately,
    which meant the Call tab could show the *last* turn's breakdown and nothing
    could answer "is this getting slower?".

    Fire-and-forget from the client: a failure here must never cost a turn.
    """
    try:
        body = await request.json()
    except Exception:
        return {"ok": False}
    total = body.get("totalMs")
    if not isinstance(total, (int, float)) or total <= 0:
        return {"ok": False}
    parts = [
        f"{label} {round(body[key])} ms"
        for key, label in (("listenMs", "heard"), ("thinkMs", "thought"), ("firstAudioMs", "first audio"))
        if isinstance(body.get(key), (int, float))
    ]
    metrics.record("voice call", "call", float(total), detail=" · ".join(parts))
    return {"ok": True}


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
# Ids are generated as `uuid4().hex`, but they arrive off the URL, so they are
# whatever the caller sent. The character class is the real guard — it leaves no
# separator, no `.` and nothing empty to build a path out of — and the resolved
# parent check stays as the belt to its braces.
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _store_path(directory: Path, item_id: str, what: str) -> Path:
    """Resolve `<directory>/<id>.json`, rejecting anything that isn't a plain id."""
    if not _SAFE_ID.match(str(item_id)):
        raise ValueError(f"invalid {what} id")
    p = (directory / f"{item_id}.json").resolve()
    if p.parent != directory.resolve():
        raise ValueError(f"invalid {what} id")
    return p


def _reading_path(reading_id: str) -> Path:
    return _store_path(cfg.readings_dir, reading_id, "reading")


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


# --- saved conversations (voice-call transcripts, resumable) ----------------
# Deliberately never written automatically. A call is a conversation someone had
# out loud in their own home; silently filing every one of them away is not a
# feature, it is a surprise. Saving is a button, and nothing here runs unless it
# is pressed.
def _conversation_path(conversation_id: str) -> Path:
    return _store_path(cfg.conversations_dir, conversation_id, "conversation")


def _load_conversation(conversation_id: str) -> dict:
    p = _conversation_path(conversation_id)
    if not p.exists():
        raise FileNotFoundError("conversation not found")
    return json.loads(p.read_text(encoding="utf-8"))


def _clean_turns(raw) -> list[dict]:
    """Keep only well-formed user/assistant turns, in order.

    The stored shape is exactly what /api/chat takes back as `messages`, which
    is what makes a saved call resumable rather than just readable.
    """
    if not isinstance(raw, list):
        raise ValueError("messages must be a list of {role, content}")
    out: list[dict] = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "")
        content = str(m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            out.append({"role": role, "content": content})
    if not out:
        raise ValueError("a conversation needs at least one turn")
    return out


def _conversation_summary(path: Path, doc: dict) -> dict:
    messages = doc.get("messages") or []
    first_user = next((m["content"] for m in messages if m.get("role") == "user"), "")
    return {
        "id": path.stem,
        "name": doc.get("name") or path.stem,
        "turnCount": len(messages),
        # Enough to recognise it in a list without loading every transcript.
        "preview": first_user[:120],
        "chatModel": doc.get("chatModel"),
        "createdAt": doc.get("createdAt") or path.stat().st_mtime * 1000,
        "updatedAt": doc.get("updatedAt") or path.stat().st_mtime * 1000,
    }


@app.get("/api/conversations")
async def api_conversations():
    """List saved conversations as summaries (no transcripts), newest first."""
    items = []
    for p in cfg.conversations_dir.glob("*.json"):
        try:
            items.append(_conversation_summary(p, json.loads(p.read_text(encoding="utf-8"))))
        except (OSError, ValueError):
            continue
    items.sort(key=lambda c: c["updatedAt"], reverse=True)
    return {"conversations": items}


@app.get("/api/conversations/{conversation_id}")
async def api_conversation(conversation_id: str):
    try:
        doc = _load_conversation(conversation_id)
    except (ValueError, FileNotFoundError):
        return JSONResponse(status_code=404, content={"error": "conversation not found"})
    return {"id": conversation_id, **doc}


@app.post("/api/conversations")
async def api_create_conversation(request: Request):
    try:
        body = await request.json()
        messages = _clean_turns(body.get("messages"))
        name = str(body.get("name") or "").strip()
        if not name:
            # A call has no title, and demanding one before saving is friction at
            # exactly the wrong moment. The first thing said is a decent name.
            name = messages[0]["content"][:60].strip() or "Gespräch"
        now = time.time() * 1000
        conversation_id = uuid.uuid4().hex
        doc = {
            "name": name,
            "messages": messages,
            "chatModel": body.get("chatModel") or None,
            "createdAt": now,
            "updatedAt": now,
        }
        _conversation_path(conversation_id).write_text(
            json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        log_bus.emit("success", f'conversation saved · "{name}" ({len(messages)} turns, {conversation_id})')
        return {"id": conversation_id, **doc}
    except Exception as e:
        log_bus.emit("error", f"saving conversation failed: {e}")
        return _fail(e)


@app.put("/api/conversations/{conversation_id}")
async def api_update_conversation(conversation_id: str, request: Request):
    """Update in place — used to re-save a conversation that was resumed."""
    try:
        try:
            doc = _load_conversation(conversation_id)
        except (ValueError, FileNotFoundError):
            return JSONResponse(status_code=404, content={"error": "conversation not found"})
        body = await request.json()
        if "name" in body:
            name = str(body.get("name") or "").strip()
            if not name:
                raise ValueError("name cannot be empty")
            doc["name"] = name
        if "messages" in body:
            doc["messages"] = _clean_turns(body.get("messages"))
        if "chatModel" in body:
            doc["chatModel"] = body.get("chatModel") or None
        doc["updatedAt"] = time.time() * 1000
        _conversation_path(conversation_id).write_text(
            json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return {"id": conversation_id, **doc}
    except Exception as e:
        log_bus.emit("error", f"updating conversation failed: {e}")
        return _fail(e)


@app.delete("/api/conversations/{conversation_id}")
async def api_delete_conversation(conversation_id: str):
    try:
        p = _conversation_path(conversation_id)
    except ValueError:
        return JSONResponse(status_code=404, content={"error": "conversation not found"})
    if not p.exists():
        return JSONResponse(status_code=404, content={"error": "conversation not found"})
    p.unlink(missing_ok=True)
    log_bus.emit("info", f"conversation deleted · {conversation_id}")
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
