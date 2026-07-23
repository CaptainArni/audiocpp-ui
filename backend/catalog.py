"""
Maps a downloaded model directory name to its audio.cpp loader family, task,
and capabilities. Derived from tools/model_manager.py CATALOG target_directory
values. Unknown directories return None so the UI can ask the user to pick.
"""

from dataclasses import dataclass, field
from typing import Callable, Literal, Optional

Task = Literal["tts", "asr"]


@dataclass(frozen=True)
class CatalogEntry:
    family: str
    task: Task
    clone: bool = False
    voice_design: bool = False
    builtin_voice_kind: Optional[Literal["pocket", "kokoro"]] = None
    load_options: dict[str, str] = field(default_factory=dict)
    session_options: dict[str, str] = field(default_factory=dict)


def _eq(name: str) -> Callable[[str], bool]:
    return lambda d: d.lower() == name.lower()


def _starts(prefix: str) -> Callable[[str], bool]:
    return lambda d: d.lower().startswith(prefix.lower())


_MATCHERS: list[tuple[Callable[[str], bool], CatalogEntry]] = [
    (
        _eq("pocket-tts"),
        CatalogEntry(
            family="pocket_tts",
            task="tts",
            clone=True,
            builtin_voice_kind="pocket",
            load_options={"language": "english"},
            session_options={"language": "english"},
        ),
    ),
    (
        lambda d: _starts("Qwen3-TTS")(d) and "voicedesign" in d.lower(),
        CatalogEntry(family="qwen3_tts", task="tts", clone=True, voice_design=True),
    ),
    (
        lambda d: _starts("Qwen3-TTS")(d) and "customvoice" in d.lower(),
        CatalogEntry(family="qwen3_tts", task="tts", clone=True),
    ),
    (_starts("Qwen3-TTS"), CatalogEntry(family="qwen3_tts", task="tts", clone=True)),
    (_eq("chatterbox"), CatalogEntry(family="chatterbox", task="tts", clone=True)),
    (_eq("MioTTS-1.7B"), CatalogEntry(family="miotts", task="tts", clone=True)),
    (_eq("OmniVoice"), CatalogEntry(family="omnivoice", task="tts", clone=True, voice_design=True)),
    (_eq("Vevo2"), CatalogEntry(family="vevo2", task="tts", clone=True)),
    (
        _eq("VoxCPM2"),
        CatalogEntry(
            family="voxcpm2",
            task="tts",
            clone=True,
            voice_design=True,
            # VoxCPM2's AudioVAE reference encoder defaults to a 240000-sample
            # capacity (15s @ 16 kHz) and fails longer clips with "AudioVAE
            # encoder sample capacity exceeded". Reference recordings can run
            # well past 25s, so budget 60s (960000 @ 16 kHz); the extra padding
            # cost is negligible on a big GPU.
            session_options={"voxcpm2.audiovae_encoder_sample_capacity": "960000"},
        ),
    ),
    # Higgs Audio v3 TTS (clone-capable). Require "tts" in the name so the
    # lowercase "higgs-audio-v3-stt" ASR directory does not match this prefix.
    (
        lambda d: _starts("Higgs-Audio")(d) and "tts" in d.lower(),
        CatalogEntry(family="higgs_audio_tts", task="tts", clone=True),
    ),
    (_eq("VibeVoice-1.5B"), CatalogEntry(family="vibevoice", task="tts", clone=True)),
    (_starts("Kokoro"), CatalogEntry(family="kokoro_tts", task="tts", builtin_voice_kind="kokoro")),
    (_starts("MOSS-TTS"), CatalogEntry(family="moss_tts", task="tts", clone=True)),
    # ASR
    (_eq("Qwen3-ASR-0.6B"), CatalogEntry(family="qwen3_asr", task="asr")),
    (_starts("parakeet"), CatalogEntry(family="parakeet_tdt", task="asr")),
    (_eq("citrinet"), CatalogEntry(family="citrinet_asr", task="asr")),
]


def lookup_catalog(dir_name: str) -> Optional[CatalogEntry]:
    for test, entry in _MATCHERS:
        if test(dir_name):
            return entry
    return None
