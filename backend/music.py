"""Music generation: request building and the take store.

The Music tab's counterpart to ``ocr.py`` — everything about turning a caption,
lyrics and a parameter set into an audio.cpp request, and everything about
keeping the results. The HTTP call itself lives in ``proxy.music``.

Two things here are load-bearing and easy to undo by accident:

* **The seed is resolved in this process, never left to the server.** audio.cpp
  picks a random seed when a request omits one and does not report it back, so an
  omitted seed produces a take that can never be rendered again. Every take is
  therefore sent an explicit seed, and that seed is what the sidecar records.
* **Every take is saved with the complete request that produced it.** A good take
  cannot be reconstructed from the audio, and the caption is usually edited
  between attempts, so the seed alone is not enough — "reproduce this" only
  works if the whole parameter set was written down at the time.
"""

from __future__ import annotations

import json
import random
import re
import time
import uuid
import wave
from pathlib import Path
from typing import Any, Optional

from config import AppConfig

# audio.cpp seeds are 32-bit; keep clear of the sign bit so the value survives
# every int type between here and the C++ side unchanged.
_SEED_MAX = 2**31 - 1

# Ids are generated here as uuid4().hex, but they come back off a URL, so the
# character class is the real guard — same reasoning as main.py's _SAFE_ID.
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Routes that need source audio, and the ones that additionally need a window.
ROUTES_NEEDING_AUDIO = {"lego", "extract", "cover", "cover-nofsq", "repaint"}
ROUTES_ACCEPTING_AUDIO = ROUTES_NEEDING_AUDIO | {"complete"}


class MusicError(ValueError):
    """A bad music request — reported as a 400, not an upstream failure."""


# --- request building ------------------------------------------------------


def _num(value: Any) -> str:
    """Format a number for the audio.cpp ``options`` map.

    The map is string-to-string on the C++ side; sending 4/4 as a string and 70
    as a float that stringifies to "70.0" is how a time signature works and a BPM
    quietly does not. Integers keep their integer spelling.
    """
    f = float(value)
    return str(int(f)) if f.is_integer() else repr(f)


def _clean(value: Any) -> str:
    return str(value).strip()


def resolve_seeds(seed: Optional[int], takes: int) -> list[int]:
    """One explicit seed per take.

    A pinned seed walks upward across takes rather than repeating: four takes of
    one seed are four identical files, which is never what "give me four" means.
    Walking (rather than re-randomising) keeps the whole batch reproducible from
    the one number the user actually chose.
    """
    if seed is None:
        return [random.randrange(0, _SEED_MAX) for _ in range(takes)]
    return [(int(seed) + i) % _SEED_MAX for i in range(takes)]


def build_request(spec: dict, *, seed: int, audio_path: Optional[str] = None) -> dict:
    """Translate the client's spec into one audio.cpp ``/v1/tasks/run`` request.

    Only fields the user actually set are sent: an omitted duration means
    ACE-Step's planner picks the length, and an omitted BPM/key/time signature
    means it infers those too. Sending our own "defaults" for them would silently
    take that away.
    """
    route = _clean(spec.get("route") or "text2music")
    caption = _clean(spec.get("caption") or "")
    if not caption:
        raise MusicError("a caption (music prompt) is required")

    if route in ROUTES_NEEDING_AUDIO and not audio_path:
        raise MusicError(f"the {route} route needs source audio")

    request: dict[str, Any] = {"text": caption, "task_route": route, "seed": int(seed)}
    options: dict[str, str] = {}

    lyrics = str(spec.get("lyrics") or "").strip()
    if lyrics:
        request["lyrics"] = lyrics
    if spec.get("language"):
        request["language"] = _clean(spec["language"])

    # -1 is audio.cpp's own "let the planner decide", and the source-locked
    # routes ignore it entirely, so only forward a positive value.
    duration = spec.get("durationSeconds")
    if duration is not None and float(duration) > 0:
        request["duration_seconds"] = float(duration)

    if spec.get("steps"):
        request["num_inference_steps"] = int(spec["steps"])
    # Turbo is guidance-distilled and ignores this; the catalog marks that with
    # supportsGuidance=false and the panel omits it rather than sending a value
    # that does nothing.
    if spec.get("guidanceScale") is not None:
        request["guidance_scale"] = float(spec["guidanceScale"])

    if audio_path and route in ROUTES_ACCEPTING_AUDIO:
        request["audio"] = audio_path

    if route == "repaint":
        start, end = spec.get("repaintStart"), spec.get("repaintEnd")
        if start is None or end is None:
            raise MusicError("the repaint route needs a start and end time")
        if float(end) <= float(start):
            raise MusicError("the repaint end must be after its start")
        request["repaint_start"] = float(start)
        request["repaint_end"] = float(end)
        if spec.get("repaintMode"):
            request["repaint_mode"] = _clean(spec["repaintMode"])
        if spec.get("repaintStrength") is not None:
            request["repaint_strength"] = float(spec["repaintStrength"])

    if spec.get("trackName"):
        request["track_name"] = _clean(spec["trackName"])
    classes = spec.get("completeTrackClasses")
    if classes:
        options["complete_track_classes"] = (
            ",".join(_clean(c) for c in classes) if isinstance(classes, list) else _clean(classes)
        )

    # Metadata: blank means "the planner infers it", which is the documented
    # default and usually the better answer. Upstream is explicit that tempo and
    # key belong here rather than in the caption.
    for key, field in (("bpm", "bpm"), ("keyscale", "keyscale"), ("timesignature", "timeSignature")):
        value = spec.get(field)
        if value not in (None, ""):
            options[key] = _num(value) if key == "bpm" else _clean(value)
    if spec.get("negativePrompt"):
        options["negative_prompt"] = _clean(spec["negativePrompt"])
    if spec.get("samplerMode"):
        options["sampler_mode"] = _clean(spec["samplerMode"])

    # "Vary this take": the same seed nudged, rather than a fresh roll.
    if spec.get("retakeSeed") is not None:
        options["retake_seed"] = _num(spec["retakeSeed"])
    if spec.get("retakeVariance") is not None:
        options["retake_variance"] = _num(spec["retakeVariance"])

    for key, field in (
        ("audio_cover_strength", "audioCoverStrength"),
        ("cover_noise_strength", "coverNoiseStrength"),
    ):
        if spec.get(field) is not None:
            options[key] = _num(spec[field])

    # ACE-Step's *internal* planner LM (it infers metadata and semantic codes) —
    # not the llama.cpp model that writes the caption. Two different models, and
    # the naming here is the only thing keeping them apart.
    planner = spec.get("planner") or {}
    for key, field in (
        ("lm_temperature", "temperature"),
        ("lm_cfg_scale", "cfgScale"),
        ("lm_top_k", "topK"),
        ("lm_top_p", "topP"),
        ("lm_repetition_penalty", "repetitionPenalty"),
    ):
        if planner.get(field) is not None:
            options[key] = _num(planner[field])

    if options:
        request["options"] = options
    return request


# --- take store ------------------------------------------------------------


def _paths(take_id: str) -> tuple[Path, Path]:
    """(wav, sidecar) for a take id, traversal-checked."""
    if not _SAFE_ID.match(str(take_id)):
        raise MusicError(f"invalid take id: {take_id}")
    root = AppConfig.get().music_dir.resolve()
    wav = (root / f"{take_id}.wav").resolve()
    if wav.parent != root:
        raise MusicError(f"invalid take id: {take_id}")
    return wav, wav.with_suffix(".json")


def _wav_info(path: Path) -> dict:
    """Duration/rate/channels read from the header, not the whole file.

    A three-minute stereo track is ~33 MB; there is no reason to hold one in
    memory to learn how long it is.
    """
    try:
        with wave.open(str(path), "rb") as w:
            rate = w.getframerate()
            return {
                "durationSec": (w.getnframes() / rate) if rate else None,
                "sampleRate": rate,
                "channels": w.getnchannels(),
            }
    except Exception:
        return {"durationSec": None, "sampleRate": None, "channels": None}


def save_take(wav: bytes, *, spec: dict, request: dict, model: str, timing: dict, seed: int) -> dict:
    """Write one take (audio + sidecar) and return its record."""
    take_id = uuid.uuid4().hex
    wav_path, meta_path = _paths(take_id)
    wav_path.write_bytes(wav)

    record = {
        "id": take_id,
        "createdAt": time.time() * 1000,
        "model": model,
        "seed": seed,
        "title": _clean(spec.get("title") or "") or _clean(spec.get("caption") or "")[:80],
        "sizeBytes": len(wav),
        **_wav_info(wav_path),
        # Both halves are kept on purpose. `spec` is what the panel can load
        # straight back into its controls; `request` is what actually went
        # upstream, which is the only thing that explains a result when the two
        # ever disagree.
        "spec": spec,
        "request": request,
        "timing": timing,
    }
    meta_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return record


def list_takes() -> list[dict]:
    """Saved takes, newest first. Sidecars without audio are ignored."""
    out: list[dict] = []
    for meta_path in AppConfig.get().music_dir.glob("*.json"):
        if not meta_path.with_suffix(".wav").exists():
            continue
        try:
            out.append(json.loads(meta_path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    out.sort(key=lambda r: r.get("createdAt") or 0, reverse=True)
    return out


def get_take(take_id: str) -> dict:
    _, meta_path = _paths(take_id)
    if not meta_path.exists():
        raise FileNotFoundError("take not found")
    return json.loads(meta_path.read_text(encoding="utf-8"))


def take_audio_path(take_id: str) -> Path:
    wav, _ = _paths(take_id)
    if not wav.exists():
        raise FileNotFoundError("take not found")
    return wav


def delete_take(take_id: str) -> bool:
    wav, meta_path = _paths(take_id)
    existed = wav.exists() or meta_path.exists()
    wav.unlink(missing_ok=True)
    meta_path.unlink(missing_ok=True)
    return existed
