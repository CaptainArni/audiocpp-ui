"""Manage the audiocpp_server child process: start/stop, health, log streaming.

Log lines (both this manager's own status messages and the child's raw
stdout/stderr) are pushed to the shared :data:`logbus.log_bus`, which owns the
backlog and SSE fan-out.
"""

import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from config import AppConfig
from logbus import log_bus
from proxy import health_sync
from serverjson import generate_server_json

CREATE_NO_WINDOW = 0x08000000


def _server_workdir(exe: str) -> "str | None":
    """Directory to run audiocpp_server from.

    The server resolves framework assets (e.g. Silero VAD for ASR chunking) via
    the relative path assets/framework/..., so it must run from the audio.cpp
    checkout root. Walk up from the exe until that directory is found.
    """
    p = Path(exe).resolve().parent
    for parent in [p, *p.parents]:
        if (parent / "assets" / "framework").is_dir():
            return str(parent)
    return None


class ServerManager:
    def __init__(self):
        self.state: str = "stopped"  # stopped | starting | running | error
        self.child: Optional[subprocess.Popen] = None
        self.pid: Optional[int] = None
        self.included_ids: list[str] = []
        self.last_error: Optional[str] = None
        self.health_models: int = 0
        self._stopping = False

    def status(self) -> dict:
        cfg = AppConfig.get()
        return {
            "state": self.state,
            "pid": self.pid,
            "includedModelIds": self.included_ids,
            "healthModels": self.health_models,
            "lastError": self.last_error,
            "host": cfg.audiocpp_host,
            "port": cfg.audiocpp_port,
            "device": cfg.audiocpp_device,
            "configPath": str(cfg.server_json_path),
        }

    # Manager status messages are "app" source; raw child output is "server".
    def _say(self, level: str, text: str):
        log_bus.emit(level, text, source="app")

    # --- lifecycle ----------------------------------------------------------
    def start(self, selected: list[dict]):
        if self.state in ("running", "starting"):
            raise RuntimeError("server is already running")
        cfg = AppConfig.get()
        exe = cfg.audiocpp_exe
        if not exe or not Path(exe).exists():
            raise RuntimeError(f"audiocpp_server not found at {exe}")

        self._cleanup_stale_server(cfg)

        path, registered = generate_server_json(selected)
        if not registered:
            raise RuntimeError("no known models selected to register")

        self.included_ids = registered
        self.last_error = None
        self._stopping = False
        self.health_models = 0
        self.state = "starting"
        self._say("info", f"starting audiocpp_server with {len(registered)} model(s): {', '.join(registered)}")
        self._say("debug", f"exe: {exe}")
        self._say("debug", f"config: {path} · {cfg.audiocpp_host}:{cfg.audiocpp_port} · device {cfg.audiocpp_device}")

        workdir = _server_workdir(exe)
        if workdir:
            self._say("debug", f"cwd: {workdir}")
        creationflags = CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self.child = subprocess.Popen(
            [exe, "--config", path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
            cwd=workdir,
        )
        self.pid = self.child.pid
        self._say("debug", f"spawned pid {self.pid}")
        threading.Thread(target=self._reader, args=(self.child.stdout, "stdout"), daemon=True).start()
        threading.Thread(target=self._reader, args=(self.child.stderr, "stderr"), daemon=True).start()
        threading.Thread(target=self._wait_exit, args=(self.child,), daemon=True).start()
        threading.Thread(target=self._poll_health, daemon=True).start()

    def _cleanup_stale_server(self, cfg) -> None:
        """Kill an orphaned audiocpp_server occupying our port before starting.

        If the backend dies without cleanup (killed terminal, crash), its child
        can survive. A new spawn then fails to bind the port while the health
        poll happily reaches the OLD process — the UI says "running" but serves
        a stale model set. Detect that here: anything already answering /health
        before we spawned must be an orphan.
        """
        if not health_sync():
            return
        port = cfg.audiocpp_port
        exe_name = Path(cfg.audiocpp_exe).name.lower()
        self._say("warn", f"something is already serving on port {port} — checking for an orphaned {exe_name}")
        if sys.platform != "win32":
            raise RuntimeError(f"port {port} is already in use; stop the other process first")

        # Console tools emit the OEM codepage (e.g. "ABHÖREN" on German Windows),
        # which is not valid UTF-8 — decode permissively; we only parse ASCII tokens.
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        ).stdout or ""
        pids: set[int] = set()
        for line in out.splitlines():
            parts = line.split()
            # TCP <local> <remote> <state> <pid> — state name is localized, match by local port.
            if len(parts) >= 5 and parts[0] == "TCP" and parts[1].endswith(f":{port}") and parts[-1].isdigit():
                pid = int(parts[-1])
                if pid > 0:
                    pids.add(pid)
        killed = False
        for pid in pids:
            info = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            ).stdout or ""
            if exe_name in info.lower():
                self._say("warn", f"killing orphaned {exe_name} (pid {pid})")
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
                killed = True
            else:
                raise RuntimeError(
                    f"port {port} is in use by another process (pid {pid}); free it or change [audiocpp].port"
                )
        if killed:
            for _ in range(20):  # wait for the port to actually free up
                if not health_sync():
                    return
                time.sleep(0.25)
            raise RuntimeError(f"could not free port {port} from the orphaned server; kill it manually")

    def _reader(self, pipe, stream: str):
        try:
            for line in iter(pipe.readline, ""):
                if line == "":
                    break
                log_bus.emit(stream, line.rstrip("\n"), source="server")
        except Exception:
            pass

    def _wait_exit(self, child: subprocess.Popen):
        code = child.wait()
        self.child = None
        self.pid = None
        if self._stopping:
            self.state = "stopped"
            self._say("info", f"server stopped (exit code {code})")
        elif self.state == "starting":
            self.state = "error"
            self.last_error = self.last_error or f"server exited before it became healthy (code {code})"
            self._say("error", self.last_error)
        elif self.state == "running":
            self.state = "error"
            self.last_error = f"server exited unexpectedly (code {code})"
            self._say("error", self.last_error)
        else:
            self._say("info", f"process exited (code={code})")

    def _poll_health(self):
        deadline = time.time() + 90
        while self.state == "starting":
            h = health_sync()
            if h:
                self.health_models = h["models"]
                self.state = "running"
                self._say("success", f"server healthy — {h['models']} model slot(s) registered")
                return
            if time.time() > deadline:
                self.last_error = "timed out waiting for /health"
                self.state = "error"
                self._say("error", self.last_error)
                return
            time.sleep(0.7)

    def stop(self):
        if not self.child or self.pid is None:
            self.state = "stopped"
            return
        pid = self.pid
        self._stopping = True
        self._say("info", f"stopping server (pid {pid})")
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
            else:
                self.child.terminate()
                try:
                    self.child.wait(timeout=5)
                except Exception:
                    self.child.kill()
        except Exception as e:
            self._say("error", f"stop error: {e}")
        self.state = "stopped"
        self.child = None
        self.pid = None


server_manager = ServerManager()
