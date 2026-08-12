"""HTTP proxy helpers for talking to the running audiocpp_server.

Every request that carries a generation/ASR command is logged (the exact body
sent upstream, with long fields truncated) along with the upstream status,
timing and payload size, so the log viewer shows what was actually run.
"""

import json
import time
from typing import AsyncIterator

import httpx

from config import AppConfig
from logbus import log_bus

# Sample rate of the PCM the streaming speech endpoint emits. The stream is
# headerless, so this is a contract rather than something we can read off it —
# measured at 48 kHz mono s16le for VoxCPM2. Clients get it in a response header.
STREAM_SAMPLE_RATE = 48000


class AudiocppError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _base() -> str:
    return AppConfig.get().audiocpp_base_url()


def _read_error(resp: httpx.Response) -> str:
    text = resp.text
    try:
        j = json.loads(text)
        return (j.get("error", {}) or {}).get("message") or j.get("message") or text
    except Exception:
        return text or f"HTTP {resp.status_code}"


def _compact(body: dict) -> str:
    """Render a request body for logs, truncating long strings (text/paths)."""
    shown = {}
    for k, v in body.items():
        if isinstance(v, str) and len(v) > 80:
            shown[k] = v[:77] + "…"
        else:
            shown[k] = v
    return json.dumps(shown, ensure_ascii=False)


def health_sync(timeout: float = 2.0) -> "dict | None":
    """Blocking health check, used by the process-manager poll thread."""
    try:
        r = httpx.get(f"{_base()}/health", timeout=timeout)
        if r.status_code != 200:
            return None
        return {"models": r.json().get("models", 0)}
    except Exception:
        return None


async def registered_models() -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{_base()}/v1/models")
    if r.status_code != 200:
        raise AudiocppError(r.status_code, _read_error(r))
    return r.json().get("data", [])


async def unload_models(model_ids: "list[str] | None" = None) -> dict:
    """Drop loaded models from VRAM. ``None`` unloads everything.

    Models are registered lazily and, once loaded, are never released — which is
    the right default for latency but means a box that has done TTS, ASR and OCR
    is holding all three indefinitely (Higgs alone is 20.6 GB). Reloading is
    transparent, so this only ever costs the next request its load time.

    The server waits for in-flight inference on each target to finish first, so
    this can take a moment while something is generating.
    """
    if model_ids:
        url, body = f"{_base()}/v1/tasks/unload_models", {"model_ids": model_ids}
    else:
        url, body = f"{_base()}/v1/tasks/unload_all_models", None
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(url, json=body)
    if r.status_code != 200:
        raise AudiocppError(r.status_code, _read_error(r))
    out = r.json()
    freed = out.get("unloaded") or []
    log_bus.emit(
        "success" if freed else "info",
        f"unloaded {len(freed)} model(s) from VRAM" + (f" · {', '.join(freed)}" if freed else " (none were loaded)"),
    )
    return out


# Autoregressive TTS models occasionally never emit their end-of-generation
# token and run until the per-request token budget is exhausted, which the
# server reports as a 500. It is a sampling accident, not a bad request: the
# same body normally succeeds on the next try, because generation is unseeded
# and re-rolls. Retrying is safe — synthesis has no side effects upstream.
_RUNAWAY_MARKERS = ("before eoc", "reached max_tokens", "max_steps")
_SPEECH_ATTEMPTS = 3


def _is_runaway(message: str) -> bool:
    low = message.lower()
    return any(marker.lower() in low for marker in _RUNAWAY_MARKERS)


async def speech(body: dict) -> bytes:
    """POST /v1/audio/speech, returning raw WAV bytes.

    Retries a run-away generation (see ``_RUNAWAY_MARKERS``) a few times before
    giving up. A body that pins ``seed`` is left alone: the retry would sample
    identically and fail the same way.
    """
    log_bus.emit("debug", f"→ POST /v1/audio/speech {_compact(body)}")
    retryable = body.get("seed") is None
    for attempt in range(1, _SPEECH_ATTEMPTS + 1):
        t0 = time.perf_counter()
        async with httpx.AsyncClient(timeout=600) as c:
            r = await c.post(f"{_base()}/v1/audio/speech", json=body)
        dt = time.perf_counter() - t0
        if r.status_code == 200:
            log_bus.emit("debug", f"← 200 /v1/audio/speech · {len(r.content)} bytes in {dt:.2f}s")
            return r.content
        msg = _read_error(r)
        last = attempt >= _SPEECH_ATTEMPTS
        if not retryable or not _is_runaway(msg) or last:
            log_bus.emit("error", f"← {r.status_code} /v1/audio/speech in {dt:.2f}s: {msg}")
            raise AudiocppError(r.status_code, msg)
        log_bus.emit(
            "warn",
            f"← {r.status_code} /v1/audio/speech in {dt:.2f}s: {msg} "
            f"— run-away generation, retrying ({attempt}/{_SPEECH_ATTEMPTS - 1})",
        )
    raise AssertionError("unreachable")  # loop either returns or raises


async def speech_stream(body: dict) -> "AsyncIterator[bytes]":
    """POST /v1/audio/speech in PCM streaming mode, yielding raw s16le chunks.

    Only models registered ``mode: "streaming"`` can serve this; the caller picks
    the path. It is what makes a spoken reply start while it is still being
    generated — measured on VoxCPM2, first audio lands in ~470 ms against ~1.5 s
    for the complete clip, and the gap widens with sentence length.

    Deliberately raw PCM rather than the base64 SSE shape the server also offers:
    no 33% encoding tax over Wi-Fi, and the phone can hand the bytes straight to
    an AudioTrack. The sample rate is not in the stream, so callers must take it
    from ``STREAM_SAMPLE_RATE``.

    Unlike ``speech`` there is no run-away retry: once the first chunk has been
    forwarded the client is already playing it, and a silent restart mid-sentence
    would be worse than the failure.
    """
    req = {**body, "response_format": "pcm", "stream_format": "audio"}
    log_bus.emit("debug", f"→ POST /v1/audio/speech (pcm stream) {_compact(req)}")
    t0 = time.perf_counter()
    first_ms = None
    total = 0
    async with httpx.AsyncClient(timeout=600) as c:
        async with c.stream("POST", f"{_base()}/v1/audio/speech", json=req) as r:
            if r.status_code != 200:
                raw = await r.aread()
                msg = _read_error(httpx.Response(r.status_code, content=raw))
                log_bus.emit("error", f"← {r.status_code} /v1/audio/speech (stream): {msg}")
                raise AudiocppError(r.status_code, msg)
            async for chunk in r.aiter_bytes():
                if not chunk:
                    continue
                if first_ms is None:
                    first_ms = (time.perf_counter() - t0) * 1000
                total += len(chunk)
                yield chunk
    dt = time.perf_counter() - t0
    seconds = total / 2 / STREAM_SAMPLE_RATE
    log_bus.emit(
        "debug",
        f"← 200 /v1/audio/speech (stream) · {seconds:.2f}s audio · "
        f"first chunk {first_ms:.0f} ms · {dt:.2f}s total" if first_ms is not None
        else f"← 200 /v1/audio/speech (stream) · empty in {dt:.2f}s",
    )


async def transcribe_stream(body: dict, audio_path: str) -> "AsyncIterator[dict]":
    """Multipart transcription with ``stream=true``, yielding transcript events.

    Requires an ASR model registered ``mode: "streaming"``. Yields
    ``{"type": "delta", "text": …}`` as decoding progresses and one
    ``{"type": "done", "text": …}`` at the end. The whole recording is uploaded
    first — this streams the *output*, which is what lets the caller show what it
    heard while the answer is still being prepared.
    """
    log_bus.emit("debug", f"→ POST /v1/audio/transcriptions (stream) {_compact(body)}")
    t0 = time.perf_counter()
    data = {"model": body["model"], "stream": "true"}
    if body.get("language"):
        data["language"] = body["language"]
    with open(audio_path, "rb") as fh:
        files = {"file": ("audio.wav", fh, "audio/wav")}
        async with httpx.AsyncClient(timeout=AppConfig.get().media_asr_timeout_sec) as c:
            async with c.stream(
                "POST", f"{_base()}/v1/audio/transcriptions", data=data, files=files
            ) as r:
                if r.status_code != 200:
                    raw = await r.aread()
                    msg = _read_error(httpx.Response(r.status_code, content=raw))
                    log_bus.emit("error", f"← {r.status_code} transcriptions (stream): {msg}")
                    raise AudiocppError(r.status_code, msg)
                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        event = json.loads(payload)
                    except ValueError:
                        continue
                    kind = event.get("type", "")
                    if kind.endswith("delta") and event.get("delta"):
                        yield {"type": "delta", "text": event["delta"]}
                    elif kind.endswith("done"):
                        yield {"type": "done", "text": event.get("text", "")}
    log_bus.emit("debug", f"← 200 transcriptions (stream) in {time.perf_counter() - t0:.2f}s")


async def transcribe(body: dict) -> dict:
    """Transcribe audio; returns the upstream JSON (at least ``text``).

    The OpenAI-compatible /v1/audio/transcriptions endpoint only ever returns
    ``text`` + ``timing`` — word timestamps are serialized exclusively by the
    generic /v1/tasks/run endpoint, so route there when they are requested.
    Its ``words`` carry ``word``/``start_sample``/``end_sample``.
    """
    options = body.get("options") or {}
    if options.get("return_timestamps"):
        path = "/v1/tasks/run"
        request: dict = {"audio": body["audio"], "options": options}
        if body.get("language"):
            request["language"] = body["language"]
        payload = {"model": body["model"], "request": request}
    else:
        path = "/v1/audio/transcriptions"
        payload = body
    log_bus.emit("debug", f"→ POST {path} {_compact(payload)}")
    t0 = time.perf_counter()
    # An hour of audio is one non-streaming request, so this can't be the default 600s.
    async with httpx.AsyncClient(timeout=AppConfig.get().media_asr_timeout_sec) as c:
        r = await c.post(f"{_base()}{path}", json=payload)
    dt = time.perf_counter() - t0
    if r.status_code != 200:
        msg = _read_error(r)
        log_bus.emit("error", f"← {r.status_code} {path} in {dt:.2f}s: {msg}")
        raise AudiocppError(r.status_code, msg)
    log_bus.emit("debug", f"← 200 {path} in {dt:.2f}s")
    return r.json()
