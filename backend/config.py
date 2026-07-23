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
    def generated_dir(self) -> Path:
        d = self.backend_dir / "generated"
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
