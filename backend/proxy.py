"""HTTP proxy helpers for talking to the running audiocpp_server.

Every request that carries a generation/ASR command is logged (the exact body
sent upstream, with long fields truncated) along with the upstream status,
timing and payload size, so the log viewer shows what was actually run.
"""

import json
import time

import httpx

from config import AppConfig
from logbus import log_bus


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


async def speech(body: dict) -> bytes:
    """POST /v1/audio/speech, returning raw WAV bytes."""
    log_bus.emit("debug", f"→ POST /v1/audio/speech {_compact(body)}")
    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(f"{_base()}/v1/audio/speech", json=body)
    dt = time.perf_counter() - t0
    if r.status_code != 200:
        msg = _read_error(r)
        log_bus.emit("error", f"← {r.status_code} /v1/audio/speech in {dt:.2f}s: {msg}")
        raise AudiocppError(r.status_code, msg)
    log_bus.emit("debug", f"← 200 /v1/audio/speech · {len(r.content)} bytes in {dt:.2f}s")
    return r.content


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
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(f"{_base()}{path}", json=payload)
    dt = time.perf_counter() - t0
    if r.status_code != 200:
        msg = _read_error(r)
        log_bus.emit("error", f"← {r.status_code} {path} in {dt:.2f}s: {msg}")
        raise AudiocppError(r.status_code, msg)
    log_bus.emit("debug", f"← 200 {path} in {dt:.2f}s")
    return r.json()
