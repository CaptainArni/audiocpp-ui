"""
Maps a downloaded model directory name to its audio.cpp loader family, task,
and capabilities. Derived from tools/model_manager.py CATALOG target_directory
values. Unknown directories return None so the UI can ask the user to pick.
"""

from dataclasses import dataclass, field
from typing import Callable, Literal, Optional

Task = Literal["tts", "asr", "gen"]


@dataclass(frozen=True)
class TokenBudget:
    """Derives a per-request ``max_tokens`` from the length of the input text.

    An autoregressive model that fails to emit its stop token generates until
    the budget runs out, so a single global ceiling makes those run-aways cost
    as much time as the ceiling allows. Scaling the budget to the text keeps a
    run-away cheap to detect while still leaving real generations room.

    ``frames_per_char`` is a generous upper bound on the model's real rate, not
    its average. ``chunk_chars`` is the size the *server* splits longer input
    into; ``max_tokens`` applies per chunk, so the budget is derived from one
    chunk rather than from the whole request.
    """

    frames_per_char: float
    minimum: int
    maximum: int
    chunk_chars: int

    def for_text(self, length: int) -> int:
        effective = min(max(length, 1), self.chunk_chars)
        return max(self.minimum, min(self.maximum, round(effective * self.frames_per_char)))


@dataclass(frozen=True)
class ModelVariant:
    """One selectable variant inside a single downloaded model directory.

    ACE-Step ships two DiT variants (turbo and base) in one package and picks
    between them with a **load** option: audio.cpp's
    ``ace_step/loader.cpp::selection_from_request`` reads a ``ModelLoadRequest``,
    not a per-request one. A variant therefore cannot be switched per request —
    each has to be registered as its own model, exactly like a pocket-tts
    language pack. Both are lazy, so the unused one costs no VRAM.
    """

    id: str
    label: str
    load_options: dict[str, str] = field(default_factory=dict)
    session_options: dict[str, str] = field(default_factory=dict)
    default: bool = False
    # Parameter defaults the UI should show for this variant. Turbo is
    # distilled to ~8 steps and effectively ignores classifier-free guidance;
    # base wants many more steps and is the variant guidance_scale acts on.
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None
    supports_guidance: bool = True


@dataclass(frozen=True)
class CatalogEntry:
    family: str
    task: Task
    clone: bool = False
    voice_design: bool = False
    builtin_voice_kind: Optional[Literal["pocket", "kokoro"]] = None
    # Register this model with ``mode: "streaming"`` instead of "offline".
    # A streaming session still answers ordinary non-streaming requests (verified
    # for voxcpm2 and nemotron_asr), so this is a pure superset: the existing
    # TTS/ASR panels are unaffected and the Call tab additionally gets
    # chunk-by-chunk audio and transcript deltas. Only set it for families
    # measured to work both ways — a streaming-only session would break /api/tts.
    streaming: bool = False
    load_options: dict[str, str] = field(default_factory=dict)
    session_options: dict[str, str] = field(default_factory=dict)
    # Per-model request-option defaults written into server.json. The audio
    # server applies these to every request for the model; anything the actual
    # request body sends overrides them.
    default_request_options: dict[str, str] = field(default_factory=dict)
    # When set, /api/tts sizes max_tokens to the request text (see TokenBudget).
    token_budget: Optional[TokenBudget] = None
    # task="gen" only: the audio.cpp task routes this family offers, and the
    # variants the package contains. Both drive the Music tab; keeping them
    # here rather than in the panel is what lets a second music family arrive
    # without touching the frontend.
    music_routes: tuple[str, ...] = ()
    variants: tuple[ModelVariant, ...] = ()


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
            # Measured: registered as "streaming", VoxCPM2 still returns a whole
            # WAV for an ordinary request *and* streams PCM for a call — first
            # audio in ~470 ms (~790 ms with a voice clone) against ~1.5 s for
            # the complete clip. That gap is the whole point of the Call tab.
            streaming=True,
            # VoxCPM2's AudioVAE reference encoder defaults to a 240000-sample
            # capacity (15s @ 16 kHz) and fails longer clips with "AudioVAE
            # encoder sample capacity exceeded". Reference recordings can run
            # well past 25s, so budget 60s (960000 @ 16 kHz); the extra padding
            # cost is negligible on a big GPU.
            session_options={"voxcpm2.audiovae_encoder_sample_capacity": "960000"},
            # A streaming session rejects retry_badcase ("VoxCPM2 streaming
            # generation requires retry_badcase=false"), which would otherwise
            # 500 every existing /api/tts call the moment streaming is enabled.
            # Defaulting it here keeps every client unchanged.
            default_request_options={"retry_badcase": "false"},
        ),
    ),
    # Higgs Audio v3 TTS (clone-capable). Require "tts" in the name so the
    # lowercase "higgs-audio-v3-stt" ASR directory does not match this prefix.
    (
        lambda d: _starts("Higgs-Audio")(d) and "tts" in d.lower(),
        CatalogEntry(
            family="higgs_audio_tts",
            task="tts",
            clone=True,
            # Higgs splits input into 1024-char chunks and gives each chunk its
            # own AR budget of max_tokens frames. Its codec runs at 25 Hz
            # (960 samples per frame at 24 kHz), so the stock 2048 only allows
            # 81.9s of audio per chunk. A full chunk of ordinary prose measures
            # ~1500-1700 frames, and because sampling is stochastic
            # (temperature 0.8 / top_p 0.8 / top_k 30) the same text varies by
            # ~16% run to run — so chunks near the top of that range randomly
            # cross 2048. When they do, the generator throws
            # "reached max_tokens before EOC" and the whole request 500s,
            # discarding every chunk already rendered. 4096 doubles the
            # headroom to 163.8s per chunk without costing VRAM up front: the
            # AR KV cache starts small and grows on demand.
            default_request_options={"max_tokens": "4096"},
            # Measured on this machine: ordinary prose runs 1.4-1.75 frames per
            # character (the codec is 25 Hz, so ~15 chars/s of speech is ~1.6).
            # 4.0 leaves room for slow narration, long pauses and the ~16%
            # run-to-run swing of unseeded sampling, while still catching a
            # run-away — which overshoots by 5-7x — in a couple of seconds
            # rather than at the global ceiling. At the server's 1024-char
            # chunk size this yields exactly the 4096 default above.
            token_budget=TokenBudget(
                frames_per_char=4.0, minimum=256, maximum=4096, chunk_chars=1024
            ),
        ),
    ),
    (_eq("VibeVoice-1.5B"), CatalogEntry(family="vibevoice", task="tts", clone=True)),
    (_starts("Kokoro"), CatalogEntry(family="kokoro_tts", task="tts", builtin_voice_kind="kokoro")),
    (_starts("MOSS-TTS"), CatalogEntry(family="moss_tts", task="tts", clone=True)),
    # Music generation (task "gen" — audio.cpp's generic /v1/tasks/run route,
    # not /v1/audio/speech; one request in, one finished WAV out, no streaming).
    (
        _starts("Ace-Step"),
        CatalogEntry(
            family="ace_step",
            task="gen",
            music_routes=(
                "text2music",
                "complete",
                "lego",
                "extract",
                "cover",
                "cover-nofsq",
                "repaint",
            ),
            variants=(
                ModelVariant(
                    id="turbo",
                    label="Turbo (fast, 8 steps)",
                    load_options={"ace_step.dit_model_path": "acestep-v15-turbo"},
                    default=True,
                    steps=8,
                    guidance_scale=1.0,
                    # Turbo is guidance-distilled: upstream's tutorial marks
                    # guidance_scale "Base model only". Offering the dial here
                    # would be offering one that does nothing.
                    supports_guidance=False,
                ),
                ModelVariant(
                    id="base",
                    label="Base (slower, guidance)",
                    load_options={"ace_step.dit_model_path": "acestep-v15-base"},
                    steps=30,
                    guidance_scale=7.0,
                ),
            ),
        ),
    ),
    # ASR
    (_eq("Qwen3-ASR-0.6B"), CatalogEntry(family="qwen3_asr", task="asr")),
    # Nemotron 3.5 ASR streaming — the fast, streaming-capable ASR the Call tab
    # wants. Measured: 22 s of German audio transcribed in 0.68 s (RTF 0.03),
    # first transcript delta at ~310 ms, and the same session answers ordinary
    # multipart transcriptions unchanged.
    (_starts("Nemotron-3.5-ASR"), CatalogEntry(family="nemotron_asr", task="asr", streaming=True)),
    (_starts("parakeet"), CatalogEntry(family="parakeet_tdt", task="asr")),
    (_eq("citrinet"), CatalogEntry(family="citrinet_asr", task="asr")),
]


def lookup_catalog(dir_name: str) -> Optional[CatalogEntry]:
    for test, entry in _MATCHERS:
        if test(dir_name):
            return entry
    return None
