"""Page-photo OCR via the llama.cpp vision server.

Sends a photographed book page to the configured vision model and returns the
transcribed text, ready to be chunked and spoken by /api/tts.

The one non-obvious requirement: the Gemma builds served here are reasoning
models. Left alone they stream their chain-of-thought into ``reasoning_content``
and loop until ``max_tokens`` with an *empty* ``content`` — a request that looks
successful but transcribes nothing. Passing
``chat_template_kwargs: {enable_thinking: false}`` is what makes the endpoint
usable; ``reasoning_budget: 0`` was tested and is ignored by this build.
"""

import base64
import time

import httpx

from config import AppConfig
from logbus import log_bus
from metrics import metrics
from proxy import AudiocppError

# Kept deliberately blunt: the model is prone to narrating what it sees unless
# told plainly to emit nothing but the page text.
OCR_PROMPT = (
    "Transkribiere den Text auf dieser Buchseite wortwörtlich.\n"
    "Regeln:\n"
    "- Gib ausschließlich den Text der Seite aus, ohne Kommentar, ohne Einleitung.\n"
    "- Behalte die Absatzstruktur bei; trenne Absätze durch eine Leerzeile.\n"
    "- Löse Silbentrennung am Zeilenende auf und füge das Wort wieder zusammen.\n"
    "- Ignoriere Seitenzahlen, Kopf- und Fußzeilen.\n"
    "- Wenn die Seite unlesbar ist oder keinen Text enthält, gib nichts aus."
)


def _read_error(resp: httpx.Response) -> str:
    try:
        j = resp.json()
        return (j.get("error", {}) or {}).get("message") or j.get("message") or resp.text
    except Exception:
        return resp.text or f"HTTP {resp.status_code}"


async def transcribe_image(
    image: bytes,
    mime: str = "image/jpeg",
    prompt: str | None = None,
    model_id: str | None = None,
) -> dict:
    """Transcribe a page photo. Returns ``{"text", "model", "seconds", "truncated"}``.

    ``model_id`` selects one of the configured OCR profiles (``[[llama.ocr_model]]``);
    when omitted the configured default is used. Each profile carries its own prompt
    and request-shaping (PaddleOCR-VL wants ``"OCR:"`` and no thinking kwarg; the Gemma
    build wants the German instruction prompt with thinking disabled).
    """
    cfg = AppConfig.get()
    profile = cfg.llama_ocr_model_by_id(model_id)
    if not profile:
        raise AudiocppError(500, "no OCR model configured ([[llama.ocr_model]] in config.toml)")

    max_tokens = profile["max_tokens"]
    b64 = base64.b64encode(image).decode("ascii")
    body: dict = {
        "model": profile["model"],
        "temperature": profile.get("temperature", 0),
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt or profile.get("prompt") or OCR_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            }
        ],
    }
    # Only reasoning models (e.g. Gemma) take enable_thinking; PaddleOCR-VL's chat
    # template can reject the kwarg, so it is opt-in per profile.
    if profile.get("send_thinking_kwarg"):
        body["chat_template_kwargs"] = {"enable_thinking": profile.get("enable_thinking", False)}
    if profile.get("repeat_penalty"):
        body["repeat_penalty"] = profile["repeat_penalty"]

    url = f"{cfg.llama_base_url()}/v1/chat/completions"
    log_bus.emit("info", f"OCR request · {profile['id']} ({profile['model']}) · image {len(image) // 1024} KB")
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=cfg.llama_timeout_sec) as c:
            r = await c.post(url, json=body)
    except httpx.RequestError as e:
        log_bus.emit("error", f"OCR unreachable at {url}: {e}")
        raise AudiocppError(502, f"OCR server unreachable at {url}: {e}") from e
    dt = time.perf_counter() - t0

    if r.status_code != 200:
        msg = _read_error(r)
        log_bus.emit("error", f"← {r.status_code} OCR in {dt:.2f}s: {msg}")
        raise AudiocppError(r.status_code, msg)

    payload = r.json()
    choice = (payload.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = (message.get("content") or "").strip()
    reasoning = (message.get("reasoning_content") or "").strip()
    finish = choice.get("finish_reason")
    usage = payload.get("usage") or {}

    # An empty content alongside a fat reasoning_content means thinking crept
    # back in — surface that instead of returning a blank page to the phone.
    if not text and reasoning:
        log_bus.emit(
            "error",
            f"OCR returned only reasoning ({len(reasoning)} chars) — "
            "the model is thinking; check [llama].enable_thinking",
        )
        raise AudiocppError(
            502,
            "the OCR model returned reasoning instead of a transcription "
            "(set [llama].enable_thinking = false)",
        )
    if finish == "length":
        log_bus.emit("warn", f"OCR hit the token limit ({max_tokens}) — the page may be cut off")

    completion_tokens = usage.get("completion_tokens")
    log_bus.emit(
        "success",
        f"OCR done · {len(text)} chars · {completion_tokens or '?'} tok in {dt:.2f}s",
    )
    tok_s = (completion_tokens / dt) if (completion_tokens and dt > 0) else None
    metrics.record(
        profile["id"], "ocr", dt * 1000, throughput=tok_s, unit="tok/s",
        detail=f"{len(text)} chars",
    )
    return {"text": text, "model": profile["id"], "seconds": round(dt, 2), "truncated": finish == "length"}
