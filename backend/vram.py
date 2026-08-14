"""Who is holding GPU memory right now, and how to make them let go.

Studio drives two inference servers that both load models lazily and then keep
them resident: `audiocpp_server` (TTS/ASR/music) and the external llama.cpp
server (OCR, chat, music prompts). Neither knows about the other, and on one GPU
they compete — a music model plus a 26B chat model does not fit alongside a 20 GB
TTS model. Each server already has its own unload call; what was missing was a
single place that can answer "what is loaded?" for both and free either one on
demand, so a workflow like *write the prompt with a big model → drop it →
generate the music* does not mean restarting anything.

Deliberately **reports rather than guesses**: both servers expose a real
per-model loaded flag (`loaded` on audio.cpp's `/v1/models`, `status.value` on
llama.cpp's), so nothing here infers residency from "has served a request".
`metrics.warmed` describes what *this backend* has served, which is a different
question and would be wrong after a restart on either side.
"""

from __future__ import annotations

import asyncio

import httpx

from config import AppConfig
from logbus import log_bus
from metrics import metrics
from process import server_manager
from proxy import AudiocppError, registered_models, unload_models

TARGETS = ("audiocpp", "llama")

# Short on purpose: this is polled by a header control, and llama.cpp being down
# is a normal state (it is started outside Studio). A long connect timeout would
# stall every poll for seconds to learn something the UI treats as "hide the
# entry".
_PROBE_TIMEOUT = 2.0
_UNLOAD_TIMEOUT = 120.0


async def _audiocpp_loaded() -> list[str]:
    """Model ids audio.cpp currently holds in VRAM.

    **audio.cpp's own `loaded` flag is not enough on its own.** Its
    `LoadedModel::unload()` (`app/server/runtime.cpp`) releases the session and
    the model but never clears `loaded`, so once a model has been loaded,
    `/v1/models` reports it loaded forever — including right after
    `/v1/tasks/unload_all_models` has demonstrably freed the memory. (Its other
    unload path, `POST /v1/models/unload`, *does* clear the flag; the bug is
    only in the two `/v1/tasks/` routes, which are the ones that can free
    everything. A one-line fix upstream.)

    So the flag is intersected with Studio's own warm set, which is exactly
    "has served a request since it was last unloaded" — every audio.cpp load is
    triggered by a request this backend made, and `metrics.on_unloaded` clears
    the flag when we free one. The intersection can only ever *under*-report;
    the Telemetry tab's Free VRAM button is deliberately ungated for that case.
    """
    if server_manager.status().get("state") != "running":
        return []
    try:
        models = await registered_models()
    except Exception:
        return []
    warm = metrics.warm_models()
    return [m["id"] for m in models if m.get("loaded") and m["id"] in warm]


async def _llama_loaded() -> tuple[list[str], bool]:
    """(loaded model ids, reachable)."""
    cfg = AppConfig.get()
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as c:
            r = await c.get(f"{cfg.llama_base_url()}/v1/models")
        if r.status_code != 200:
            return [], False
        data = r.json().get("data", [])
    except Exception:
        return [], False
    return [
        m["id"] for m in data if m.get("id") and (m.get("status") or {}).get("value") == "loaded"
    ], True


async def status() -> dict:
    """What each server is running and holding. Safe to poll."""
    audio_task = asyncio.create_task(_audiocpp_loaded())
    llama_task = asyncio.create_task(_llama_loaded())
    audio_loaded = await audio_task
    llama_loaded, llama_up = await llama_task
    server = server_manager.status()
    return {
        "audiocpp": {
            "running": server.get("state") == "running",
            "loaded": audio_loaded,
        },
        "llama": {
            "running": llama_up,
            "loaded": llama_loaded,
        },
    }


async def _free_llama(ids: list[str]) -> list[str]:
    """Unload each named llama.cpp model.

    llama.cpp's router unloads **one model per call** (`POST /models/unload`
    with `{"model": id}`); there is no unload-everything route, so freeing the
    GPU means walking the loaded list. A model that fails to unload is skipped
    rather than aborting the rest — the point of the button is to get memory
    back, and one stubborn model should not keep the others resident.
    """
    cfg = AppConfig.get()
    freed: list[str] = []
    async with httpx.AsyncClient(timeout=_UNLOAD_TIMEOUT) as c:
        for model_id in ids:
            try:
                r = await c.post(f"{cfg.llama_base_url()}/models/unload", json={"model": model_id})
                if r.status_code == 200:
                    freed.append(model_id)
                else:
                    log_bus.emit("warn", f"llama.cpp refused to unload {model_id}: HTTP {r.status_code}")
            except Exception as e:
                log_bus.emit("warn", f"llama.cpp unload failed for {model_id}: {e}")
    return freed


async def free(targets: list[str]) -> dict:
    """Release VRAM on the named servers. Returns what each actually freed."""
    unknown = [t for t in targets if t not in TARGETS]
    if unknown:
        raise ValueError(f"unknown VRAM target(s): {', '.join(unknown)}")

    out: dict[str, list[str]] = {}
    if "audiocpp" in targets:
        try:
            freed = (await unload_models()).get("unloaded") or []
        except AudiocppError as e:
            log_bus.emit("warn", f"audio.cpp unload failed: {e.message}")
            freed = []
        metrics.on_unloaded(freed)
        out["audiocpp"] = freed
    if "llama" in targets:
        loaded, up = await _llama_loaded()
        out["llama"] = await _free_llama(loaded) if up else []

    total = sum(len(v) for v in out.values())
    log_bus.emit(
        "success" if total else "info",
        "freed VRAM · "
        + " · ".join(f"{k}: {', '.join(v) if v else 'nothing loaded'}" for k, v in out.items()),
    )
    return out
