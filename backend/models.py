"""Scan the audio.cpp models directory and describe each downloaded model."""

import json
from pathlib import Path
from typing import Optional

from catalog import lookup_catalog
from config import AppConfig


def _dir_size_mb(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return round(total / (1024 * 1024))


def _safetensor_basenames(path: Path) -> list[str]:
    if not path.exists():
        return []
    return sorted(p.stem for p in path.glob("*.safetensors"))


def _find_key(obj, key: str):
    """Depth-first search for a key anywhere in a nested JSON structure."""
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            found = _find_key(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_key(v, key)
            if found is not None:
                return found
    return None


def _qwen3_tts_languages(model_path: Path) -> list[str]:
    """Languages the Qwen3-TTS talker accepts, from codec_language_id in config.json."""
    try:
        doc = json.loads((model_path / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    ids = _find_key(doc, "codec_language_id")
    if not isinstance(ids, dict) or not ids:
        return []
    return ["auto"] + sorted(ids.keys())


def _find_vad_assets(models_root: Path) -> Optional[Path]:
    """Locate the framework Silero VAD assets in the audio.cpp checkout.

    models_dir usually lives at <audio.cpp root>/models, and the framework
    assets at <audio.cpp root>/assets/framework/models/silero_vad.
    """
    for parent in [models_root.resolve(), *models_root.resolve().parents]:
        cand = parent / "assets" / "framework" / "models" / "silero_vad"
        if cand.is_dir():
            return cand
    return None


def _enumerate_voices(model_path: Path, kind: Optional[str]) -> tuple[list[str], list[str]]:
    if kind == "pocket":
        languages_dir = model_path / "languages"
        if not languages_dir.exists():
            return [], []
        languages = sorted(p.name for p in languages_dir.iterdir() if p.is_dir())
        voices = _safetensor_basenames(languages_dir / languages[0] / "embeddings") if languages else []
        return languages, voices
    if kind == "kokoro":
        return [], _safetensor_basenames(model_path / "voices")
    return [], []


def scan_models() -> list[dict]:
    cfg = AppConfig.get()
    root = Path(cfg.audiocpp_models_dir)
    if not root.exists():
        return []

    # The forced aligner is a helper model attached to Qwen3-ASR (for word
    # timestamps), not a standalone TTS/ASR model — don't list it.
    aligner_dir = next((p for p in root.iterdir() if p.is_dir() and "forcedaligner" in p.name.lower()), None)

    models: list[dict] = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if aligner_dir is not None and entry == aligner_dir:
            continue
        cat = lookup_catalog(entry.name)
        languages, voices = _enumerate_voices(entry, cat.builtin_voice_kind if cat else None)
        if cat and cat.family == "qwen3_tts" and not languages:
            languages = _qwen3_tts_languages(entry)

        # Qwen3-ASR only produces word timestamps with the forced aligner
        # attached as a session option.
        timestamps = False
        extra_session: dict[str, str] = {}
        if cat and cat.family == "qwen3_asr" and aligner_dir is not None:
            extra_session["qwen3_asr.forced_aligner_model_path"] = str(aligner_dir.resolve())
            timestamps = True
            # Chunked/timestamped ASR uses Silero VAD, resolved relative to the
            # server's cwd by default — pin it absolutely so it always loads.
            vad = _find_vad_assets(root)
            if vad is not None:
                extra_session["qwen3_asr.vad_model_path"] = str(vad)

        # Walking the tree is per-directory, not per-row: a music package is
        # ~14 GB across two variants and would otherwise be measured twice.
        size_mb = _dir_size_mb(entry)

        def make(
            model_id: str,
            langs: list[str],
            vs: list[str],
            load: "dict | None",
            session: "dict | None",
            music: "dict | None" = None,
        ) -> dict:
            session = {**(session or {}), **extra_session} or None
            return {
                "defaultRequestOptions": (cat.default_request_options or None) if cat else None,
                "id": model_id,
                "dir": entry.name,
                "path": str(entry.resolve()),
                "known": cat is not None,
                "family": cat.family if cat else None,
                "task": cat.task if cat else None,
                "clone": cat.clone if cat else False,
                "voiceDesign": cat.voice_design if cat else False,
                "streaming": cat.streaming if cat else False,
                "languages": langs,
                "builtinVoices": vs,
                "loadOptions": load,
                "sessionOptions": session,
                "timestamps": timestamps,
                "sizeMB": size_mb,
                # Only music (task "gen") models carry this; keeping it nested
                # means a TTS row does not grow a dozen null music fields.
                "music": music,
            }

        # pocket_tts loads exactly one language pack per model instance, so when
        # several packs are downloaded expose one selectable model per pack.
        if cat and cat.builtin_voice_kind == "pocket" and len(languages) > 1:
            for lang in languages:
                lang_voices = _safetensor_basenames(entry / "languages" / lang / "embeddings")
                opts = {"language": lang}
                models.append(make(f"{entry.name}@{lang}", [lang], lang_voices, opts, dict(opts)))
            continue

        # A music package can hold several variants (ACE-Step: turbo + base)
        # that are chosen by a *load* option, so each has to be its own
        # registered model — the same shape as a pocket-tts language pack.
        # Both are lazy, so only the variant actually used costs VRAM.
        if cat and cat.variants:
            for v in cat.variants:
                # An optional variant the package does not ship (see requires_dir).
                if v.requires_dir and not (entry / v.requires_dir).is_dir():
                    continue
                models.append(
                    make(
                        f"{entry.name}@{v.id}",
                        languages,
                        voices,
                        {**cat.load_options, **v.load_options} or None,
                        {**cat.session_options, **v.session_options} or None,
                        music={
                            "variant": v.id,
                            "variantLabel": v.label,
                            "isDefault": v.default,
                            "routes": list(cat.music_routes),
                            "steps": v.steps,
                            "guidanceScale": v.guidance_scale,
                            "supportsGuidance": v.supports_guidance,
                        },
                    )
                )
            continue

        models.append(
            make(
                entry.name,
                languages,
                voices,
                (cat.load_options or None) if cat else None,
                (cat.session_options or None) if cat else None,
            )
        )
    return models
