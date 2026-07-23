"""
audio.cpp Studio - Browser Application
Starts the server in a background thread and opens the default web browser.
"""

import sys
from pathlib import Path

from config import AppConfig

# Load configuration
cfg = AppConfig.get()

import threading
import time
import webbrowser

import uvicorn
from main import app


class Server:
    """Uvicorn server wrapper that can be started in a thread."""

    def __init__(self, host: str = "127.0.0.1", port: int = 8000):
        self.host = host
        self.port = port
        self.server = None
        self.thread = None

    def start(self):
        """Start the server in a background thread."""
        config = uvicorn.Config(
            app,
            host=self.host,
            port=self.port,
            log_level="warning",
            access_log=False,
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()

        # Wait for server to start
        while not getattr(self.server, "started", False):
            time.sleep(0.1)

    def stop(self):
        """Stop the server."""
        if self.server:
            self.server.should_exit = True


def main():
    # Check if static files exist
    staticDir = Path(__file__).parent / "static"
    if not staticDir.exists() or not (staticDir / "index.html").exists():
        print("ERROR: Frontend not built!")
        print("Please run scripts/build.bat first to build the frontend.")
        sys.exit(1)

    # Start the server. Bind to the configured host so [server].host = "0.0.0.0"
    # can expose the API to the LAN (the Android companion app); the browser
    # itself always opens over loopback.
    server = Server(host=cfg.server_host, port=cfg.server_port)
    server.start()

    url = f"http://127.0.0.1:{cfg.server_port}"
    print(f"Server started at {url} (bound to {cfg.server_host})")

    # Open default browser
    print("Opening default browser...")
    webbrowser.open(url, new=2)

    # Keep running until interrupted
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("Shutting down server...")
        server.stop()
        if server.thread:
            server.thread.join(timeout=5)

    print("Browser application exited.")


if __name__ == "__main__":
    main()
