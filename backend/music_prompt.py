"""Turn a one-line musical idea into a full ACE-Step request, via llama.cpp.

``ocr.py``'s sibling on the text side: a non-streaming ``/v1/chat/completions``
call against the same llama.cpp server, shaped by a profile from config
(``[[llama.music_prompt]]``). The profile is selected by the **music** model's
family, so choosing an ACE-Step model brings ACE-Step's prompting rules with it
and a second music family would bring its own.

The output contract is structured JSON, not a longer sentence. That is the whole
point: a prettier paragraph still leaves BPM, key, time signature and lyrics for
the user to fill in by hand, and ACE-Step is explicit that tempo and key must
*not* live in the caption. Returning fields is what lets one click populate the
form.

Model output is untrusted input here — it is parsed defensively, and a reply that
is not JSON at all degrades to "use the whole thing as the caption" rather than
failing. A usable caption beats an error toast.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Optional

import httpx

from config import AppConfig
from logbus import log_bus
from metrics import metrics
from proxy import AudiocppError

# Appended to the profile's system prompt so one prompt covers both modes.
LYRICS_ON = (
    'Write original lyrics for this song in the "lyrics" field, using the '
    "structure tags described above."
)
LYRICS_OFF = (
    'Do not write any lyrics. Set "lyrics" to "[Instrumental]" and describe the '
    "arrangement through the caption and through instrumental section tags only."
)

# Models that are asked for JSON still like to wrap it in a fence or introduce it.
_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)

_STRING_FIELDS = ("caption", "lyrics", "keyscale", "timesignature", "language", "title")
_NUMBER_FIELDS = (("bpm", int), ("durationSeconds", float))

# The one field whose name differs between the three contracts it passes
# through: the model is asked for `timesignature` (which is also audio.cpp's
# option key), while a client spec calls it `timeSignature`. `fields` is spread
# straight into the caller's draft, so without this rename the enhanced time
# signature lands under a key nothing reads and is silently dropped.
_RENAME = {"timesignature": "timeSignature"}


def _read_error(resp: httpx.Response) -> str:
    try:
        j = resp.json()
        return (j.get("error", {}) or {}).get("message") or j.get("message") or resp.text
    except Exception:
        return resp.text or f"HTTP {resp.status_code}"


def _extract_json(text: str) -> Optional[dict]:
    """Pull the JSON object out of a model reply, or None if there isn't one."""
    fenced = _FENCE.search(text)
    if fenced:
        text = fenced.group(1)
    text = text.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    # Prose before or after the object is common enough to be worth one retry on
    # the outermost braces rather than discarding an otherwise good answer.
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        return None


def _coerce(raw: dict, *, with_lyrics: bool) -> dict:
    """Keep only the fields the Music tab knows, with the types it expects."""
    out: dict[str, Any] = {}
    for key in _STRING_FIELDS:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            out[_RENAME.get(key, key)] = value.strip()
    for key, cast in _NUMBER_FIELDS:
        value = raw.get(key)
        if value in (None, ""):
            continue
        try:
            out[_RENAME.get(key, key)] = cast(value)
        except (TypeError, ValueError):
            continue
    # A model told not to write lyrics sometimes writes them anyway; the switch
    # is the user's instruction, so it wins over the model's enthusiasm.
    if not with_lyrics:
        out["lyrics"] = "[Instrumental]"
    return out


async def enhance(
    idea: str,
    *,
    family: str | None = None,
    profile_id: str | None = None,
    model: str | None = None,
    system_prompt: str | None = None,
    with_lyrics: bool = True,
) -> dict:
    """Expand ``idea`` into caption/lyrics/metadata fields.

    Returns ``{"fields": {...}, "raw": str, "model": str, "profile": str,
    "seconds": float, "parsed": bool}``. ``parsed`` is False when the reply was
    not JSON and the whole text was used as the caption — the panel says so
    rather than pretending the metadata simply came back empty.
    """
    cfg = AppConfig.get()
    idea = (idea or "").strip()
    if not idea:
        raise ValueError("an idea is required")

    profile = cfg.llama_music_prompt_by_id(profile_id, family)
    if profile is None and not system_prompt:
        raise AudiocppError(
            500,
            f"no music prompt profile configured for family '{family or '?'}' "
            "([[llama.music_prompt]] in config.toml)",
        )
    profile = profile or {}
    chat_model = model or profile.get("model") or ""
    if not chat_model:
        raise ValueError("a llama.cpp model is required to enhance a prompt")

    base_prompt = (system_prompt or profile.get("system_prompt") or "").strip()
    full_prompt = f"{base_prompt}\n\n{LYRICS_ON if with_lyrics else LYRICS_OFF}"

    body: dict[str, Any] = {
        "model": chat_model,
        "temperature": profile.get("temperature", 0.8),
        "max_tokens": profile.get("max_tokens", 1400),
        "messages": [
            {"role": "system", "content": full_prompt},
            {"role": "user", "content": idea},
        ],
    }
    if profile.get("send_thinking_kwarg", True):
        body["chat_template_kwargs"] = {"enable_thinking": profile.get("enable_thinking", False)}

    url = f"{cfg.llama_base_url()}/v1/chat/completions"
    log_bus.emit(
        "info",
        f"music prompt · {profile.get('id', 'custom')} ({chat_model}) · "
        f"{'with lyrics' if with_lyrics else 'instrumental'} · \"{idea[:60]}\"",
    )
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=cfg.llama_timeout_sec) as c:
            r = await c.post(url, json=body)
        # A chat template that rejects the kwarg answers 400 to the kwarg, not to
        # the prompt — same one-shot retry chat.py makes for the same reason.
        if r.status_code == 400 and "chat_template_kwargs" in body:
            log_bus.emit("warn", f"{chat_model} rejected chat_template_kwargs — retrying without it")
            body.pop("chat_template_kwargs")
            async with httpx.AsyncClient(timeout=cfg.llama_timeout_sec) as c:
                r = await c.post(url, json=body)
    except httpx.RequestError as e:
        log_bus.emit("error", f"music prompt unreachable at {url}: {e}")
        raise AudiocppError(
            502,
            f"the llama.cpp server is not responding at {cfg.llama_base_url()} "
            f"— start it on the PC, then try again ({e})",
        ) from e
    dt = time.perf_counter() - t0

    if r.status_code != 200:
        msg = _read_error(r)
        log_bus.emit("error", f"← {r.status_code} music prompt in {dt:.2f}s: {msg}")
        raise AudiocppError(r.status_code, msg)

    payload = r.json()
    choice = (payload.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = (message.get("content") or "").strip()
    reasoning = (message.get("reasoning_content") or "").strip()
    if not text and reasoning:
        # Same failure ocr.py documents: thinking crept back in and the answer
        # never arrived. Say which knob turns it off instead of returning blanks.
        raise AudiocppError(
            502,
            "the model returned only reasoning and no prompt "
            "(set enable_thinking = false on its [[llama.music_prompt]] profile)",
        )
    if not text:
        raise AudiocppError(502, "the model returned an empty prompt")

    raw_fields = _extract_json(text)
    parsed = raw_fields is not None
    fields = _coerce(raw_fields or {}, with_lyrics=with_lyrics) if parsed else {"caption": text}
    if not fields.get("caption"):
        # JSON without a caption is no more useful than no JSON at all.
        fields["caption"] = text
        parsed = False

    if choice.get("finish_reason") == "length":
        log_bus.emit("warn", f"music prompt hit the token limit ({body['max_tokens']}) — it may be cut off")
    log_bus.emit(
        "success" if parsed else "warn",
        f"music prompt {'ready' if parsed else 'was not JSON — using the reply as the caption'} · "
        f"{len(fields.get('caption', ''))} char caption · {dt:.2f}s",
    )
    usage = payload.get("usage") or {}
    completion_tokens = usage.get("completion_tokens")
    metrics.record(
        chat_model, "chat", dt * 1000,
        throughput=(completion_tokens / dt) if (completion_tokens and dt > 0) else None,
        unit="tok/s", detail="music prompt",
    )
    return {
        "fields": fields,
        "raw": text,
        "model": chat_model,
        "profile": profile.get("id", ""),
        "seconds": round(dt, 2),
        "parsed": parsed,
    }
