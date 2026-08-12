"""Generate the audiocpp_server config (server.json) from selected models."""

import json

from config import AppConfig


def generate_server_json(selected: list[dict]) -> tuple[str, list[str]]:
    """Write server.json for the selected downloaded models.

    All models are registered as ``lazy`` so the server starts fast and only
    loads a model into VRAM on its first request (lazy multi-model).
    Returns (path, registered_ids).
    """
    cfg = AppConfig.get()

    models = []
    for m in selected:
        if not m.get("family") or not m.get("task"):
            continue
        # A streaming session is a superset here: it answers ordinary requests
        # *and* can emit audio/transcript chunks as they are produced, which is
        # what makes a voice call feel live. Only the families the catalog marks
        # `streaming` get it, because a family whose streaming session refused
        # offline requests would break /api/tts and /api/transcribe.
        entry: dict = {
            "id": m["id"],
            "family": m["family"],
            "path": m["path"],
            "task": m["task"],
            "mode": "streaming" if m.get("streaming") else "offline",
            "lazy": True,
        }
        load_options = dict(m.get("loadOptions") or {})
        session_options = dict(m.get("sessionOptions") or {})
        # pocket_tts picks its language pack at load time; the catalog default is
        # "english", but only a downloaded languages/<name>/ directory can load.
        downloaded = m.get("languages") or []
        if m["family"] == "pocket_tts" and downloaded and load_options.get("language") not in downloaded:
            fallback = "english" if "english" in downloaded else downloaded[0]
            load_options["language"] = fallback
            session_options["language"] = fallback
        if load_options:
            entry["load_options"] = load_options
        if session_options:
            entry["session_options"] = session_options
        request_options = dict(m.get("defaultRequestOptions") or {})
        if request_options:
            entry["default_request_options"] = request_options
        models.append(entry)

    doc = {
        "host": cfg.audiocpp_host,
        "port": cfg.audiocpp_port,
        "device": cfg.audiocpp_device,
        "threads": cfg.audiocpp_threads,
        "lazy_load": True,
        "models": models,
    }

    path = cfg.server_json_path
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return str(path), [m["id"] for m in models]
