"""
audio.cpp Studio Desktop Application
Uses pywebview to display the web application in a native window.
"""

import sys
from pathlib import Path

# Set a unique App User Model ID before any window is created.
# This breaks the process's association with python.exe so that Windows
# treats it as its own application and respects runtime icon changes on the taskbar.
if sys.platform == "win32":
    import ctypes
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("audiocpp.studio")

from config import AppConfig

# Load configuration
cfg = AppConfig.get()

import threading
import time

import uvicorn
import webview
from main import app
from process import server_manager


def _read_version() -> str:
    """Read the app version from version.json (project root), defaulting to 0.0.0."""
    import json
    version_file = Path(__file__).parent.parent / "version.json"
    try:
        return json.loads(version_file.read_text(encoding="utf-8")).get("version", "0.0.0")
    except Exception:
        return "0.0.0"


def _find_main_hwnd() -> int:
    """Return the HWND of the first visible top-level window owned by this process."""
    import ctypes
    import os

    pid = os.getpid()
    result = ctypes.c_size_t(0)

    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_size_t, ctypes.c_size_t)

    def _cb(hwnd, _):
        proc_id = ctypes.c_ulong()
        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(proc_id))
        if proc_id.value == pid and ctypes.windll.user32.IsWindowVisible(hwnd):
            result.value = hwnd
            return False  # stop enumeration
        return True

    ctypes.windll.user32.EnumWindows(EnumWindowsProc(_cb), 0)
    return result.value


def _apply_window_icon_windows(titlebar_png: str, taskbar_png: str) -> None:
    """Set separate title bar and taskbar icons on Windows using GDI+ and Win32 API.

    pywebview's icon= parameter is only supported on GTK/Qt/Cocoa (Linux/macOS) and
    is silently ignored - or raises a .NET exception with PNG files - on Windows.
    This uses gdiplus.dll (always present on Windows since XP) and is wrapped in
    try/except so missing files or API failures never crash the app.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes

        class _GdiplusStartupInput(ctypes.Structure):
            _fields_ = [
                ("GdiplusVersion", ctypes.c_uint32),
                ("DebugEventCallback", ctypes.c_void_p),
                ("SuppressBackgroundThread", ctypes.c_bool),
                ("SuppressExternalCodecs", ctypes.c_bool),
            ]

        gdiplus = ctypes.windll.gdiplus
        token = ctypes.c_ulong()
        startup_input = _GdiplusStartupInput(GdiplusVersion=1)
        gdiplus.GdiplusStartup(ctypes.byref(token), ctypes.byref(startup_input), None)

        def _load_hicon(path: str) -> ctypes.c_void_p:
            bmp = ctypes.c_void_p()
            gdiplus.GdipCreateBitmapFromFile(ctypes.c_wchar_p(path), ctypes.byref(bmp))
            ico = ctypes.c_void_p()
            gdiplus.GdipCreateHICONFromBitmap(bmp, ctypes.byref(ico))
            gdiplus.GdipDisposeImage(bmp)
            return ico

        hicon_titlebar = _load_hicon(titlebar_png)
        hicon_taskbar = _load_hicon(taskbar_png)

        hwnd = _find_main_hwnd()
        if hwnd:
            WM_SETICON = 0x0080
            if hicon_titlebar.value:
                ctypes.windll.user32.SendMessageW(hwnd, WM_SETICON, 0, hicon_titlebar.value)
            if hicon_taskbar.value:
                ctypes.windll.user32.SendMessageW(hwnd, WM_SETICON, 1, hicon_taskbar.value)
                GCLP_HICON = -14
                GCLP_HICONSM = -34
                ctypes.windll.user32.SetClassLongPtrW(hwnd, GCLP_HICON, hicon_taskbar.value)
                ctypes.windll.user32.SetClassLongPtrW(hwnd, GCLP_HICONSM, hicon_taskbar.value)

        gdiplus.GdiplusShutdown(token)
    except Exception:
        pass


def _enable_media_autoallow_windows(window) -> None:
    """Auto-allow microphone in the WebView2 window so in-app voice recording
    (getUserMedia) works without a permission prompt.

    WebView2's default is to show a one-time permission prompt; that also works,
    but auto-allowing gives a smoother in-app experience. This attaches a
    CoreWebView2.PermissionRequested handler on the UI thread once the control is
    ready. Fully best-effort: any failure silently falls back to the default
    prompt. Passing WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS does NOT work here
    because pywebview sets AdditionalBrowserArguments itself and it wins.
    """
    if sys.platform != "win32":
        return

    def worker():
        try:
            from System import Action
            from Microsoft.Web.WebView2.Core import (
                CoreWebView2PermissionKind,
                CoreWebView2PermissionState,
            )
        except Exception:
            return

        control = getattr(window.native, "webview", None)
        if control is None:
            return

        def on_permission(sender, args):
            try:
                if args.PermissionKind == CoreWebView2PermissionKind.Microphone:
                    args.State = CoreWebView2PermissionState.Allow
            except Exception:
                pass

        done = {"ok": False}

        def attach():
            try:
                core = control.CoreWebView2
                if core is not None:
                    core.PermissionRequested += on_permission
                    done["ok"] = True
            except Exception:
                pass

        # CoreWebView2 initializes asynchronously; retry until it's ready.
        for _ in range(50):
            try:
                control.Invoke(Action(attach))
            except Exception:
                pass
            if done["ok"]:
                return
            time.sleep(0.1)

    threading.Thread(target=worker, daemon=True).start()


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
        while not self.server.started:
            time.sleep(0.1)

    def stop(self):
        """Stop the server."""
        if self.server:
            self.server.should_exit = True


def main():
    """Main entry point for the desktop application."""
    # Check if static files exist
    staticDir = Path(__file__).parent / "static"
    if not staticDir.exists() or not (staticDir / "index.html").exists():
        print("ERROR: Frontend not built!")
        print("Please run scripts/build.bat first to build the frontend.")
        sys.exit(1)

    # Start the server. Bind to the configured host so [server].host = "0.0.0.0"
    # can expose the API to the LAN (the Android companion app); the window
    # itself always loads over loopback.
    server = Server(host=cfg.server_host, port=cfg.server_port)
    server.start()

    print(f"Server started at http://127.0.0.1:{cfg.server_port} (bound to {cfg.server_host})")

    # Load the SPA at a version-stamped URL so a new version always busts the
    # WebView's document cache (localStorage is keyed by origin, so it persists).
    appUrl = f"http://127.0.0.1:{cfg.server_port}/?v={_read_version()}"

    window = webview.create_window(
        title="audio.cpp Studio",
        url=appUrl,
        width=cfg.desktop_width,
        height=cfg.desktop_height,
        resizable=True,
        min_size=(cfg.desktop_min_width, cfg.desktop_min_height),
        maximized=cfg.desktop_maximized,
        zoomable=True,
        text_select=True,
    )

    def on_closed():
        """Handle window close event."""
        server.stop()

    window.events.closed += on_closed

    # Disable private_mode so localStorage/cookies persist between sessions
    storagePath = str(Path(__file__).parent / "webview_storage")

    titlebarIconPath = str(Path(__file__).parent / "icons" / "icon_small.png")
    taskbarIconPath = str(Path(__file__).parent / "icons" / "icon_large.png")

    # On Windows, pywebview's icon= parameter is silently ignored AND can raise a
    # .NET exception with PNG files in some builds. Pass icon=None on Windows and
    # apply the icon via Win32 API once the window becomes visible.
    if sys.platform == "win32":
        def on_shown():
            _apply_window_icon_windows(titlebarIconPath, taskbarIconPath)
            _enable_media_autoallow_windows(window)
        window.events.shown += on_shown

    iconArg = None if sys.platform == "win32" else taskbarIconPath
    webview.start(private_mode=False, storage_path=storagePath, icon=iconArg)

    # The uvicorn thread is a daemon: if we exit before its lifespan shutdown
    # runs, audiocpp_server is orphaned and keeps the port + VRAM. Stop the
    # inference server explicitly, then give uvicorn a moment to shut down.
    server_manager.stop()
    server.stop()
    if server.thread is not None:
        server.thread.join(timeout=10)

    print("Desktop application closed.")


if __name__ == "__main__":
    main()
