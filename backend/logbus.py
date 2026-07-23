"""
Central log bus for audio.cpp Studio.

Collects log entries from the FastAPI app (endpoint / generation activity) and
from the audiocpp_server child process into a single bounded backlog, mirrors
each entry to the standard :mod:`logging` (so it also lands in the uvicorn
console), and fans entries out to any connected SSE subscribers (the in-UI log
viewer).

Each entry is a small JSON-serialisable dict::

    {"t": <epoch ms>, "source": "app" | "server", "level": <level>, "line": <text>}

Levels:
    debug | info | success | warn | error   -> emitted by the app
    stdout | stderr                          -> raw audiocpp_server output

The frontend colours lines by ``level`` and dims the ``source`` tag, so keep
the vocabulary stable when adding new call sites.
"""

import asyncio
import logging
import time
from collections import deque
from typing import Optional

MAX_LOGS = 800

# Map our log levels onto stdlib logging levels for the console mirror.
_PYLEVEL = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "success": logging.INFO,
    "warn": logging.WARNING,
    "error": logging.ERROR,
    "stdout": logging.INFO,
    "stderr": logging.INFO,
}

_pylog = logging.getLogger("audiocpp.studio")


class LogBus:
    """Single sink for app + child-process log lines with SSE fan-out."""

    def __init__(self, maxlen: int = MAX_LOGS):
        self.logs: deque = deque(maxlen=maxlen)
        self.subscribers: set[asyncio.Queue] = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        """Capture the event loop so worker threads can post into SSE queues."""
        self.loop = loop

    # --- SSE subscriber management -----------------------------------------
    def snapshot(self) -> list:
        return list(self.logs)

    def add_subscriber(self, q: asyncio.Queue):
        self.subscribers.add(q)

    def remove_subscriber(self, q: asyncio.Queue):
        self.subscribers.discard(q)

    # --- emitting ----------------------------------------------------------
    def emit(self, level: str, message: str, *, source: str = "app"):
        """Record a log line (split on newlines) and fan it out.

        Safe to call from any thread; delivery to SSE queues is marshalled onto
        the captured event loop.
        """
        for part in message.splitlines() or [""]:
            # Drop blank lines from chatty child output; app lines are never blank.
            if not part.strip() and source == "server":
                continue
            entry = {
                "t": int(time.time() * 1000),
                "source": source,
                "level": level,
                "line": part,
            }
            self.logs.append(entry)
            _pylog.log(_PYLEVEL.get(level, logging.INFO), "[%s] %s", source, part)
            self._fanout(entry)

    def _fanout(self, entry: dict):
        if self.loop is None:
            return
        for q in list(self.subscribers):
            try:
                self.loop.call_soon_threadsafe(q.put_nowait, entry)
            except RuntimeError:
                # Loop already closed (shutdown) — drop the line.
                pass


log_bus = LogBus()
