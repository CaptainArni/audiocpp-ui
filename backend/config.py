"""
Configuration loader for audio.cpp Studio.
Reads settings from config.toml, looked up in data/ first, then project root.
"""

from pathlib import Path
from typing import Any

import tomllib


class AppConfig:
    """Application configuration loaded from config.toml."""

    _instance: "AppConfig | None" = None
    _data: dict[str, Any]

    def __init__(self, config_path: Path | None = None):
        if config_path is None:
            data_config = Path(__file__).parent.parent / "data" / "config.toml"
            root_config = Path(__file__).parent.parent / "config.toml"
            config_path = data_config if data_config.exists() else root_config

        if config_path.exists():
            with open(config_path, "rb") as f:
                self._data = tomllib.load(f)
        else:
            self._data = {}

    # --- Server (the FastAPI/uvicorn app that serves this UI) ---
    @property
    def server_host(self) -> str:
        return self._data.get("server", {}).get("host", "0.0.0.0")

    @property
    def server_port(self) -> int:
        return self._data.get("server", {}).get("port", 8000)

    @property
    def server_reload(self) -> bool:
        return self._data.get("server", {}).get("reload", True)

    @property
    def server_log_level(self) -> str:
        return self._data.get("server", {}).get("log_level", "info")

    @property
    def cors_origins(self) -> list[str]:
        return self._data.get("server", {}).get("cors", {}).get("origins", [])

    def get_all_cors_origins(self) -> list[str]:
        """Return CORS origins including the server's own origin."""
        origins = list(self.cors_origins)
        own_origins = [
            f"http://localhost:{self.server_port}",
            f"http://127.0.0.1:{self.server_port}",
        ]
        for o in own_origins:
            if o not in origins:
                origins.append(o)
        return origins

    # --- Desktop window ---
    @property
    def desktop_width(self) -> int:
        return self._data.get("desktop", {}).get("width", 1400)

    @property
    def desktop_height(self) -> int:
        return self._data.get("desktop", {}).get("height", 900)

    @property
    def desktop_min_width(self) -> int:
        return self._data.get("desktop", {}).get("min_width", 1024)

    @property
    def desktop_min_height(self) -> int:
        return self._data.get("desktop", {}).get("min_height", 768)

    @property
    def desktop_maximized(self) -> bool:
        return self._data.get("desktop", {}).get("maximized", True)

    # --- audio.cpp server (the C++ inference server we control) ---
    @property
    def audiocpp_exe(self) -> str:
        return self._data.get("audiocpp", {}).get("exe", "")

    @property
    def audiocpp_models_dir(self) -> str:
        return self._data.get("audiocpp", {}).get("models_dir", "")

    @property
    def audiocpp_host(self) -> str:
        return self._data.get("audiocpp", {}).get("host", "127.0.0.1")

    @property
    def audiocpp_port(self) -> int:
        return self._data.get("audiocpp", {}).get("port", 8080)

    @property
    def audiocpp_device(self) -> int:
        return self._data.get("audiocpp", {}).get("device", 0)

    @property
    def audiocpp_threads(self) -> int:
        return self._data.get("audiocpp", {}).get("threads", 1)

    @property
    def audiocpp_autostart(self) -> bool:
        return self._data.get("audiocpp", {}).get("autostart", True)

    def audiocpp_base_url(self) -> str:
        return f"http://{self.audiocpp_host}:{self.audiocpp_port}"

    # --- llama.cpp server (vision OCR; started outside this app) ---
    @property
    def llama_host(self) -> str:
        return self._data.get("llama", {}).get("host", "127.0.0.1")

    @property
    def llama_port(self) -> int:
        return self._data.get("llama", {}).get("port", 8080)

    @property
    def llama_model(self) -> str:
        return self._data.get("llama", {}).get("model", "")

    @property
    def llama_enable_thinking(self) -> bool:
        return self._data.get("llama", {}).get("enable_thinking", False)

    @property
    def llama_max_tokens(self) -> int:
        return self._data.get("llama", {}).get("max_tokens", 2048)

    @property
    def llama_timeout_sec(self) -> float:
        return float(self._data.get("llama", {}).get("timeout_sec", 180))

    def llama_base_url(self) -> str:
        return f"http://{self.llama_host}:{self.llama_port}"

    # --- OCR model profiles (selectable from the Android app) ---
    # Each entry pairs a llama.cpp model name with the prompt + request shaping
    # that model family needs, so switching model also switches how we call it.
    @property
    def llama_ocr_models(self) -> list[dict[str, Any]]:
        raw = self._data.get("llama", {}).get("ocr_model", [])
        models: list[dict[str, Any]] = []
        for e in raw:
            model_name = e.get("model") or e.get("id")
            if not model_name:
                continue
            mid = e.get("id") or model_name
            models.append(
                {
                    "id": mid,
                    "label": e.get("label", mid),
                    "model": model_name,
                    "prompt": e.get("prompt"),  # None => fall back to the default OCR prompt
                    "temperature": e.get("temperature", 0),
                    "max_tokens": e.get("max_tokens", self.llama_max_tokens),
                    "send_thinking_kwarg": e.get("send_thinking_kwarg", False),
                    "enable_thinking": e.get("enable_thinking", self.llama_enable_thinking),
                    "repeat_penalty": e.get("repeat_penalty"),
                }
            )
        # Backward compat: no [[llama.ocr_model]] tables, but a flat [llama].model.
        if not models and self.llama_model:
            models.append(
                {
                    "id": self.llama_model,
                    "label": self.llama_model,
                    "model": self.llama_model,
                    "prompt": None,
                    "temperature": 0,
                    "max_tokens": self.llama_max_tokens,
                    "send_thinking_kwarg": True,
                    "enable_thinking": self.llama_enable_thinking,
                    "repeat_penalty": None,
                }
            )
        return models

    @property
    def llama_default_ocr_model(self) -> str:
        models = self.llama_ocr_models
        ids = [m["id"] for m in models]
        explicit = self._data.get("llama", {}).get("default_ocr_model", "")
        if explicit and explicit in ids:
            return explicit
        return ids[0] if ids else ""

    def llama_ocr_model_by_id(self, model_id: str | None) -> dict[str, Any] | None:
        """Resolve a profile by id, falling back to the configured default."""
        models = self.llama_ocr_models
        if not models:
            return None
        if model_id:
            for m in models:
                if m["id"] == model_id:
                    return m
        default_id = self.llama_default_ocr_model
        for m in models:
            if m["id"] == default_id:
                return m
        return models[0]

    # --- Music prompt profiles (idea -> caption/lyrics/metadata via llama.cpp) ---
    # Keyed by the *music* model's family, not by an id the client has to know:
    # selecting an ACE-Step model has to bring ACE-Step's prompting rules with it,
    # and a family that takes a plain scene description with no lyrics, key or BPM
    # has to bring completely different ones. Matching on family is what makes
    # that switch automatic instead of a mapping the frontend must maintain.
    @property
    def llama_music_prompts(self) -> list[dict[str, Any]]:
        raw = self._data.get("llama", {}).get("music_prompt", [])
        out: list[dict[str, Any]] = []
        for e in raw:
            family = e.get("family")
            system_prompt = (e.get("system_prompt") or "").strip()
            if not family or not system_prompt:
                continue
            pid = e.get("id") or family
            out.append(
                {
                    "id": pid,
                    "label": e.get("label", pid),
                    "family": family,
                    "default": bool(e.get("default", False)),
                    # Blank = use whatever chat model the client picked.
                    "model": e.get("model", ""),
                    "system_prompt": system_prompt,
                    "temperature": float(e.get("temperature", 0.8)),
                    "max_tokens": int(e.get("max_tokens", 1400)),
                    "send_thinking_kwarg": e.get("send_thinking_kwarg", True),
                    "enable_thinking": e.get("enable_thinking", False),
                }
            )
        return out

    def llama_music_prompts_for(self, family: str | None) -> list[dict[str, Any]]:
        profiles = self.llama_music_prompts
        if not family:
            return profiles
        return [p for p in profiles if p["family"] == family]

    def llama_music_prompt_by_id(
        self, profile_id: str | None, family: str | None = None
    ) -> dict[str, Any] | None:
        """Resolve a profile by id, then by the family's default, then anything.

        An id wins even when it disagrees with ``family`` — the caller asked for
        that profile explicitly, and silently substituting another one would make
        an edited prompt appear not to take effect.
        """
        profiles = self.llama_music_prompts
        if profile_id:
            for p in profiles:
                if p["id"] == profile_id:
                    return p
        candidates = self.llama_music_prompts_for(family)
        for p in candidates:
            if p["default"]:
                return p
        return candidates[0] if candidates else None

    # --- Voice call (Call tab: mic -> ASR -> llama.cpp chat -> TTS) ---
    # Chat models are *discovered* from the llama.cpp server's /v1/models rather
    # than declared here (unlike the OCR profiles): llama-swap already knows every
    # model it can serve, so a hand-written list would only go stale. What config
    # owns is the parts llama.cpp cannot tell us — the spoken-conversation system
    # prompt, the length presets, and the turn-taking defaults.
    @property
    def _call(self) -> dict[str, Any]:
        return self._data.get("call", {})

    @property
    def call_system_prompt(self) -> str:
        return self._call.get("system_prompt", "").strip()

    @property
    def call_default_chat_model(self) -> str:
        return self._call.get("default_chat_model", "")

    @property
    def call_default_tts_model(self) -> str:
        return self._call.get("default_tts_model", "")

    @property
    def call_default_asr_model(self) -> str:
        return self._call.get("default_asr_model", "")

    @property
    def call_temperature(self) -> float:
        return float(self._call.get("temperature", 0.7))

    @property
    def call_top_p(self) -> float:
        return float(self._call.get("top_p", 0.95))

    @property
    def call_thinking_tokens(self) -> int:
        """Extra token budget granted when thinking is on.

        Reasoning is spent from the same max_tokens as the answer, so a short
        preset plus thinking means the model reasons until the cap and never
        answers at all (measured: ~340 tokens of which ~1200 characters were
        reasoning, against a "Kurz" budget of 140). Adding a separate allowance
        is what keeps the thinking switch usable at every response length.
        """
        return int(self._call.get("thinking_tokens", 900))

    @property
    def call_context_messages(self) -> int:
        """How many prior turns to resend; the system prompt is always kept."""
        return int(self._call.get("context_messages", 20))

    @property
    def call_timeout_sec(self) -> float:
        return float(self._call.get("timeout_sec", 300))

    @property
    def call_vad_hangover_ms(self) -> int:
        return int(self._call.get("vad_hangover_ms", 700))

    @property
    def call_vad_preroll_ms(self) -> int:
        return int(self._call.get("vad_preroll_ms", 300))

    @property
    def call_filler_after_ms(self) -> int:
        """Play the cached filler clip if nothing has been spoken this long. 0 = off."""
        return int(self._call.get("filler_after_ms", 1500))

    @property
    def call_filler_text(self) -> str:
        return self._call.get("filler_text", "Moment…")

    @property
    def call_code_placeholder(self) -> str:
        """Spoken in place of a fenced code block. Blank = say nothing.

        Reading code aloud is useless, but dropping it silently is worse: the
        answer appears on screen and nothing comes out of the speakers, which is
        indistinguishable from a broken voice. Ending it like a sentence is what
        lets the segmenter cut after it.
        """
        return self._call.get("code_placeholder", "Codeblock ausgelassen.")

    @property
    def call_lengths(self) -> list[dict[str, Any]]:
        """Response-length presets. max_tokens alone truncates mid-word, so each
        preset also carries the instruction that tells the model to be that long."""
        raw = self._call.get("length", [])
        out: list[dict[str, Any]] = []
        for e in raw:
            lid = e.get("id")
            if not lid:
                continue
            out.append(
                {
                    "id": lid,
                    "label": e.get("label", lid),
                    "max_tokens": int(e.get("max_tokens", 400)),
                    "instruction": e.get("instruction", ""),
                }
            )
        return out

    @property
    def call_default_length(self) -> str:
        ids = [x["id"] for x in self.call_lengths]
        explicit = self._call.get("default_length", "")
        if explicit and explicit in ids:
            return explicit
        return ids[0] if ids else ""

    def call_length_by_id(self, length_id: str | None) -> dict[str, Any] | None:
        lengths = self.call_lengths
        if not lengths:
            return None
        if length_id:
            for x in lengths:
                if x["id"] == length_id:
                    return x
        default_id = self.call_default_length
        for x in lengths:
            if x["id"] == default_id:
                return x
        return lengths[0]

    # --- Media conversion (ffmpeg; audio/video uploads -> WAV) ---
    @property
    def media_ffmpeg(self) -> str:
        """Explicit ffmpeg path; blank means resolve "ffmpeg" from PATH."""
        return self._data.get("media", {}).get("ffmpeg", "")

    @property
    def media_ffprobe(self) -> str:
        return self._data.get("media", {}).get("ffprobe", "")

    @property
    def media_max_duration_sec(self) -> float:
        return float(self._data.get("media", {}).get("max_duration_sec", 3600))

    @property
    def media_max_upload_mb(self) -> int:
        return int(self._data.get("media", {}).get("max_upload_mb", 2048))

    @property
    def media_convert_timeout_sec(self) -> float:
        return float(self._data.get("media", {}).get("convert_timeout_sec", 1800))

    @property
    def media_uploads_retention_hours(self) -> float:
        """Age at which uploads are pruned; 0 disables pruning."""
        return float(self._data.get("media", {}).get("uploads_retention_hours", 24))

    @property
    def media_asr_timeout_sec(self) -> float:
        """How long to wait on the audio server for one transcription."""
        return float(self._data.get("media", {}).get("asr_timeout_sec", 900))

    # --- Music generation (Music tab: prompt -> ACE-Step -> a saved track) ---
    @property
    def _music(self) -> dict[str, Any]:
        return self._data.get("music", {})

    @property
    def music_timeout_sec(self) -> float:
        """How long to wait on the audio server for one rendered take.

        Measured on this machine (RTX 5090, ACE-Step turbo): 30 s of music in
        ~9 s including a cold model load, 180 s in ~17 s. The default is wide
        enough for the base variant at high step counts and a long duration.
        """
        return float(self._music.get("timeout_sec", 900))

    @property
    def music_default_model(self) -> str:
        """Registered model id preselected in the Music tab; blank = first found."""
        return self._music.get("default_model", "")

    @property
    def music_max_takes(self) -> int:
        """Cap on takes per generate request.

        Takes are rendered sequentially against one model, so this is a bound on
        how long a single request can hold the audio server — not just a UI
        limit.
        """
        return max(1, int(self._music.get("max_takes", 8)))

    @property
    def music_default_duration_sec(self) -> float:
        """Blank/-1 lets ACE-Step's planner choose the length itself."""
        return float(self._music.get("default_duration_sec", 120))

    # --- Android companion app ---
    @property
    def android_repo_dir(self) -> Path | None:
        """Checkout of the companion app, so Studio can hand out its APK.

        Blank (the default) turns the feature off rather than guessing: the
        sibling layout in the README is a convention, not something to assume
        about someone else's disk. A relative path is taken from the project
        root, which is where ``../audiocpp-android`` actually points.
        """
        raw = str(self._data.get("android", {}).get("repo_dir", "")).strip()
        if not raw:
            return None
        p = Path(raw)
        return p if p.is_absolute() else (self.backend_dir.parent / p).resolve()

    @property
    def android_apk_path(self) -> Path | None:
        """The debug APK Gradle writes — the same file Android Studio produces,
        so a build from the IDE is picked up with nothing else to do."""
        root = self.android_repo_dir
        if root is None:
            return None
        return root / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"

    # --- Paths (all relative to backend/) ---
    @property
    def backend_dir(self) -> Path:
        return Path(__file__).parent.resolve()

    @property
    def static_dir(self) -> Path:
        return self.backend_dir / "static"

    @property
    def uploads_dir(self) -> Path:
        d = self.backend_dir / "uploads"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def voices_dir(self) -> Path:
        d = self.backend_dir / "voices"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def readings_dir(self) -> Path:
        d = self.backend_dir / "readings"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def conversations_dir(self) -> Path:
        """Saved voice-call transcripts. Written only when the user asks."""
        d = self.backend_dir / "conversations"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def generated_dir(self) -> Path:
        d = self.backend_dir / "generated"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def music_dir(self) -> Path:
        """Rendered music takes — deliberately *not* generated/.

        Speech output in generated/ is scratch: it is re-rendered on demand from
        text that is stored elsewhere. A music take is the opposite — it cannot
        be reproduced from anything but its own recorded parameters, and it is
        two orders of magnitude larger (a 3-minute track is ~33 MB against a few
        hundred kB for a sentence). Keeping the two apart is what lets generated/
        stay disposable while takes are kept.
        """
        d = self.backend_dir / "music"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def server_json_path(self) -> Path:
        return self.generated_dir / "server.json"

    @classmethod
    def get(cls) -> "AppConfig":
        """Get the singleton config instance."""
        if cls._instance is None:
            cls._instance = AppConfig()
        return cls._instance

    @classmethod
    def load(cls, config_path: Path | None = None) -> "AppConfig":
        """Load (or reload) configuration from a specific path."""
        cls._instance = AppConfig(config_path)
        return cls._instance
