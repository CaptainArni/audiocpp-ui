"""Media conversion via ffmpeg: any audio/video file -> mono 16-bit PCM WAV.

The rest of the app (and both clients) only ever handles WAV. This module is the
single place that knows about containers and codecs, so /api/uploads can accept a
dropped .mkv or a phone recording without either UI carrying a decoder.

ffmpeg is a *soft* dependency: when it is missing, everything that worked before
still works — only non-WAV uploads are refused, with an explanation.
"""

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from config import AppConfig
from logbus import log_bus

# Same flag process.py uses — keep the console window from flashing on Windows.
CREATE_NO_WINDOW = 0x08000000

# Containers we accept as "video" from the clients. Used for messaging only;
# ffprobe is the real authority on what is inside a file.
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".m4v", ".mov", ".avi", ".webm", ".ts", ".flv", ".wmv", ".mpg", ".mpeg"}


class MediaError(Exception):
    """A conversion/probe failure with a message meant for the user."""


_tool_cache: dict[str, "str | None"] = {}


def _tool(name: str, configured: str) -> "str | None":
    """Resolve ffmpeg/ffprobe: the configured path first, then PATH. Cached."""
    if name in _tool_cache:
        return _tool_cache[name]
    found: "str | None" = None
    if configured:
        p = Path(configured)
        if p.is_file():
            found = str(p)
    if found is None:
        found = shutil.which(name)
    _tool_cache[name] = found
    return found


def ffmpeg_path() -> "str | None":
    return _tool("ffmpeg", AppConfig.get().media_ffmpeg)


def ffprobe_path() -> "str | None":
    return _tool("ffprobe", AppConfig.get().media_ffprobe)


def _run(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    """Run a tool with no shell, no window, and captured output."""
    kwargs: dict = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        **kwargs,
    )


def ffmpeg_version() -> "str | None":
    """First line of `ffmpeg -version`, or None when ffmpeg isn't available."""
    exe = ffmpeg_path()
    if not exe:
        return None
    try:
        r = _run([exe, "-version"], timeout=15)
        return r.stdout.splitlines()[0].strip() if r.stdout else None
    except Exception:
        return None


def support() -> dict:
    """What the clients need to know before offering a video/audio file picker."""
    cfg = AppConfig.get()
    exe = ffmpeg_path()
    return {
        "ffmpeg": bool(exe),
        "version": ffmpeg_version() if exe else None,
        "maxDurationSec": cfg.media_max_duration_sec,
        "maxUploadMb": cfg.media_max_upload_mb,
    }


def probe(path: Path) -> dict:
    """Inspect a media file: {durationSec, hasAudio, hasVideo, format, codec}."""
    exe = ffprobe_path()
    if not exe:
        raise MediaError(
            "ffprobe was not found — install ffmpeg (or set [media].ffprobe in config.toml) "
            "to use audio and video files other than .wav"
        )
    args = [exe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]
    try:
        r = _run(args, timeout=60)
    except subprocess.TimeoutExpired:
        raise MediaError("ffprobe timed out reading the file") from None
    if r.returncode != 0:
        detail = (r.stderr or "").strip().splitlines()
        raise MediaError(f"could not read the media file: {detail[-1] if detail else 'ffprobe failed'}")

    try:
        info = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        raise MediaError("could not read the media file (unreadable ffprobe output)") from None

    streams = info.get("streams") or []
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    video = [s for s in streams if s.get("codec_type") == "video"]
    fmt = info.get("format") or {}

    # Duration lives on the format, but some containers only carry it per stream.
    duration = 0.0
    for candidate in (fmt.get("duration"), *(s.get("duration") for s in streams)):
        try:
            duration = float(candidate)
            if duration > 0:
                break
        except (TypeError, ValueError):
            continue

    return {
        "durationSec": duration if duration > 0 else None,
        "hasAudio": bool(audio),
        # A cover-art JPEG inside an MP3 is a video stream; don't call that a video.
        "hasVideo": any(s.get("codec_name") not in ("mjpeg", "png", "bmp", "gif") for s in video),
        "format": (fmt.get("format_name") or "").split(",")[0],
        "codec": audio[0].get("codec_name") if audio else None,
    }


def to_wav(src: Path, dst: Path, rate: int = 16000) -> float:
    """Transcode any media file to mono 16-bit PCM WAV at `rate`. Returns wall seconds.

    -vn drops the picture, so a video file costs no more than its audio track.
    """
    exe = ffmpeg_path()
    if not exe:
        raise MediaError(
            "ffmpeg was not found — install ffmpeg (or set [media].ffmpeg in config.toml) "
            "to use audio and video files other than .wav"
        )
    args = [
        exe, "-nostdin", "-v", "error", "-y",
        "-i", str(src),
        "-vn", "-map_metadata", "-1",
        "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s16le",
        str(dst),
    ]
    t0 = time.perf_counter()
    try:
        r = _run(args, timeout=AppConfig.get().media_convert_timeout_sec)
    except subprocess.TimeoutExpired:
        dst.unlink(missing_ok=True)
        raise MediaError("audio extraction timed out — the file is too long or the machine is busy") from None
    elapsed = time.perf_counter() - t0

    if r.returncode != 0 or not dst.exists() or dst.stat().st_size <= 44:
        dst.unlink(missing_ok=True)
        detail = (r.stderr or "").strip().splitlines()
        msg = detail[-1] if detail else f"ffmpeg exited with {r.returncode}"
        log_bus.emit("error", f"ffmpeg failed · {src.name} → {msg}")
        raise MediaError(f"audio extraction failed: {msg}")

    log_bus.emit(
        "info",
        f"ffmpeg · {src.name} → {rate // 1000} kHz mono wav "
        f"({dst.stat().st_size // 1024} KB) in {elapsed:.2f}s",
    )
    return elapsed


def prune_uploads() -> int:
    """Delete uploads older than the configured retention. Returns how many.

    Uploads are transient scratch (a reference clip or an ASR input, consumed
    right after) but video-derived audio is large — an hour at 16 kHz mono is
    ~115 MB — so the directory needs a sweep.
    """
    cfg = AppConfig.get()
    hours = cfg.media_uploads_retention_hours
    if hours <= 0:
        return 0
    cutoff = time.time() - hours * 3600
    removed = 0
    freed = 0
    try:
        for p in cfg.uploads_dir.iterdir():
            if not p.is_file():
                continue
            try:
                st = p.stat()
                if st.st_mtime < cutoff:
                    freed += st.st_size
                    p.unlink()
                    removed += 1
            except OSError:
                continue
    except OSError:
        return removed
    if removed:
        log_bus.emit("info", f"pruned {removed} upload(s) older than {hours}h ({freed // (1024 * 1024)} MB freed)")
    return removed
