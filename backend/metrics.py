"""In-memory telemetry for generation activity.

A tiny, thread-safe store the request handlers feed after each successful TTS /
ASR / OCR call. It tracks, per model: how many requests it has served, whether
it is "warm" (has served a request since the audio server last started — a
usable proxy for "loaded in VRAM"), its last wall time, and a throughput figure
(realtime-factor for TTS, tok/s for OCR). Plus a short ring of recent events.

Deliberately not persisted: it describes the *current* running session and is
cheap to rebuild. Mirrored to nothing — read via GET /api/telemetry.
"""

import time
from collections import deque
from threading import Lock
from typing import Any


class Metrics:
    def __init__(self) -> None:
        self._lock = Lock()
        self._models: dict[str, dict[str, Any]] = {}
        self._events: deque[dict[str, Any]] = deque(maxlen=40)
        self._server_epoch: float = 0.0

    def on_server_start(self) -> None:
        """The audio server (re)started: its models are cold again."""
        with self._lock:
            self._server_epoch = time.time()
            for m in self._models.values():
                # OCR and chat run on a separate llama.cpp server, so leave
                # those warm; everything the audio server hosts went cold.
                if m.get("kind") in ("tts", "asr", "music"):
                    m["warmed"] = False

    def on_unloaded(self, model_ids: list[str]) -> None:
        """These models were dropped from VRAM, so they are cold again.

        Without this the Telemetry tab keeps calling them warm right after the
        Free VRAM button visibly emptied the card.
        """
        with self._lock:
            for mid in model_ids:
                m = self._models.get(mid)
                if m is not None:
                    m["warmed"] = False

    def record(
        self,
        model: str,
        kind: str,
        ms: float,
        throughput: float | None = None,
        unit: str | None = None,
        detail: str = "",
    ) -> None:
        now = time.time() * 1000
        with self._lock:
            m = self._models.setdefault(model, {"count": 0})
            m["kind"] = kind
            m["count"] = m.get("count", 0) + 1
            m["warmed"] = True
            m["lastMs"] = round(ms, 1)
            m["lastAt"] = now
            if throughput is not None:
                m["lastThroughput"] = round(throughput, 2)
                m["throughputUnit"] = unit
            self._events.appendleft(
                {
                    "at": now,
                    "model": model,
                    "kind": kind,
                    "ms": round(ms, 1),
                    "throughput": round(throughput, 2) if throughput is not None else None,
                    "unit": unit,
                    "detail": detail,
                }
            )

    def warm_models(self) -> set[str]:
        """Models that have served a request since they were last unloaded.

        For audio.cpp this doubles as the only reliable residency signal Studio
        has — see the note in vram.py about its `loaded` flag never being
        cleared on unload.
        """
        with self._lock:
            return {k for k, v in self._models.items() if v.get("warmed")}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            models = [{"model": k, **v} for k, v in self._models.items()]
            models.sort(key=lambda x: x.get("lastAt", 0), reverse=True)
            return {
                "models": models,
                "events": list(self._events),
                "serverEpoch": self._server_epoch * 1000,
            }


# Module-level singleton, imported wherever generations are recorded.
metrics = Metrics()
