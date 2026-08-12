"""Streaming chat against the llama.cpp server — the conversation half of a call.

``ocr.py``'s text-only sibling. Two differences that matter:

* it **streams**, because the first spoken word cannot wait for the last token; and
* the chat models are **discovered** from the server's ``/v1/models`` rather than
  declared in config.toml. llama-swap already knows every model it can serve, so
  a hand-maintained list would only go stale — config owns the parts llama.cpp
  cannot tell us (the spoken-conversation prompt, the length presets).

The reasoning trap documented in ``ocr.py`` applies here too: these builds put
their chain-of-thought in ``reasoning_content``. In a call that text must never
reach the synthesiser, so the two channels are split at the source and only
``content`` is fed to the segmenter.
"""

import json
import time
from typing import AsyncIterator

import httpx

from config import AppConfig
from logbus import log_bus
from metrics import metrics
from proxy import AudiocppError
from speakable import SentenceStreamer

# Chat templates differ: some reject `chat_template_kwargs` outright (the OCR
# config notes the same about PaddleOCR-VL). Rather than make the user declare
# which, we send it, and remember the ones that refuse so the retry is paid once.
_NO_THINKING_KWARG: set[str] = set()


def _read_error(resp: httpx.Response) -> str:
    try:
        j = resp.json()
        return (j.get("error", {}) or {}).get("message") or j.get("message") or resp.text
    except Exception:
        return resp.text or f"HTTP {resp.status_code}"


def _unreachable(cfg: AppConfig, err: Exception) -> AudiocppError:
    """Name the process and the remedy — this message reaches the phone, where
    nobody can act on a bare host:port. Mirrors ocr.py."""
    return AudiocppError(
        502,
        f"the llama.cpp server is not responding at {cfg.llama_base_url()} "
        f"— start llama.cpp on the PC, then try again ({err})",
    )


async def list_models() -> list[dict]:
    """Chat models the llama.cpp server can serve, loaded ones first.

    ``loaded`` matters for a call: switching to an unloaded model costs a
    llama-swap load before the first token, so the picker can warn about it.
    """
    cfg = AppConfig.get()
    url = f"{cfg.llama_base_url()}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(url)
    except httpx.RequestError as e:
        raise _unreachable(cfg, e) from e
    if r.status_code != 200:
        raise AudiocppError(r.status_code, _read_error(r))

    out = []
    for m in r.json().get("data", []):
        mid = m.get("id")
        if not mid:
            continue
        arch = m.get("architecture") or {}
        outputs = arch.get("output_modalities") or ["text"]
        if "text" not in outputs:
            continue
        status = (m.get("status") or {}).get("value")
        out.append(
            {
                "id": mid,
                "label": mid,
                "loaded": status == "loaded",
                "vision": "image" in (arch.get("input_modalities") or []),
            }
        )
    out.sort(key=lambda m: (not m["loaded"], m["id"]))
    return out


def build_messages(history: list[dict], system_prompt: str, length_instruction: str) -> list[dict]:
    """Prepend the system prompt (plus the length instruction) to the history.

    The length instruction is part of the system message rather than a separate
    one because max_tokens alone only truncates mid-word — the model has to be
    *told* to be brief for a short answer to end on a sentence.
    """
    system = "\n".join(p for p in (system_prompt.strip(), length_instruction.strip()) if p)
    messages = [{"role": "system", "content": system}] if system else []
    for m in history:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    return messages


async def stream_chat(
    model: str,
    messages: list[dict],
    *,
    thinking: bool,
    max_tokens: int,
    temperature: float | None = None,
    top_p: float | None = None,
) -> AsyncIterator[dict]:
    """Stream one assistant turn.

    Yields ``{"type": "reasoning"|"text", "delta": …}`` as tokens arrive,
    ``{"type": "speak", "index", "text"}`` for each segment that is ready to be
    synthesised, and finally ``{"type": "done", …}``. ``speak`` segments are the
    unit of playback for every client, so neither Studio nor the phone has to
    reimplement segmentation.
    """
    cfg = AppConfig.get()
    body: dict = {
        "model": model,
        "messages": messages,
        "stream": True,
        # Without this llama.cpp omits `usage` from a streamed response, and the
        # telemetry panel would show every call at "? tok".
        "stream_options": {"include_usage": True},
        "max_tokens": max_tokens,
        "temperature": cfg.call_temperature if temperature is None else temperature,
        "top_p": cfg.call_top_p if top_p is None else top_p,
    }
    if model not in _NO_THINKING_KWARG:
        body["chat_template_kwargs"] = {"enable_thinking": thinking}

    log_bus.emit(
        "info",
        f"chat request · {model} · {len(messages)} msg · max_tokens={max_tokens}"
        f" · thinking={'on' if thinking else 'off'}",
    )

    # The refusal is detected before a single event is yielded, so the retry
    # cannot duplicate output.
    try:
        async for event in _stream_once(cfg, body, model):
            yield event
        return
    except _TemplateRefused as refusal:
        _NO_THINKING_KWARG.add(model)
        body.pop("chat_template_kwargs", None)
        log_bus.emit(
            "warn",
            f"{model} rejected chat_template_kwargs ({refusal}) — retrying without it; "
            "the thinking switch has no effect on this model",
        )
    async for event in _stream_once(cfg, body, model):
        yield event


class _TemplateRefused(Exception):
    """The chat template rejected `chat_template_kwargs`; retry without it."""


async def _stream_once(cfg: AppConfig, body: dict, model: str) -> AsyncIterator[dict]:
    url = f"{cfg.llama_base_url()}/v1/chat/completions"
    segmenter = SentenceStreamer(cfg.call_code_placeholder)
    text_parts: list[str] = []
    reasoning_chars = 0
    finish_reason = None
    completion_tokens = None
    t0 = time.perf_counter()
    first_token_ms = None

    try:
        async with httpx.AsyncClient(timeout=cfg.call_timeout_sec) as c:
            async with c.stream("POST", url, json=body) as r:
                if r.status_code != 200:
                    raw = await r.aread()
                    msg = _read_error(httpx.Response(r.status_code, content=raw))
                    if "chat_template_kwargs" in body and _looks_like_template_refusal(msg):
                        raise _TemplateRefused(msg)
                    log_bus.emit("error", f"← {r.status_code} /v1/chat/completions: {msg}")
                    raise AudiocppError(r.status_code, msg)

                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except ValueError:
                        continue

                    usage = chunk.get("usage") or {}
                    if usage.get("completion_tokens"):
                        completion_tokens = usage["completion_tokens"]
                    choice = (chunk.get("choices") or [{}])[0]
                    if choice.get("finish_reason"):
                        finish_reason = choice["finish_reason"]
                    delta = choice.get("delta") or {}

                    reasoning = delta.get("reasoning_content") or ""
                    if reasoning:
                        reasoning_chars += len(reasoning)
                        yield {"type": "reasoning", "delta": reasoning}

                    content = delta.get("content") or ""
                    if not content:
                        continue
                    if first_token_ms is None:
                        first_token_ms = (time.perf_counter() - t0) * 1000
                    text_parts.append(content)
                    yield {"type": "text", "delta": content}
                    for segment in segmenter.feed(content):
                        yield {"type": "speak", "index": segmenter.emitted - 1, "text": segment}
    except httpx.RequestError as e:
        log_bus.emit("error", f"chat unreachable at {url}: {e}")
        raise _unreachable(cfg, e) from e

    for segment in segmenter.finish():
        yield {"type": "speak", "index": segmenter.emitted - 1, "text": segment}

    dt = time.perf_counter() - t0
    text = "".join(text_parts).strip()

    # Same failure mode ocr.py guards: all thinking, no answer. Silence in a call
    # is indistinguishable from a hang, so say what happened.
    if not text and reasoning_chars:
        log_bus.emit(
            "error",
            f"chat returned only reasoning ({reasoning_chars} chars) — the model kept thinking",
        )
        raise AudiocppError(
            502,
            "the model produced only reasoning and no answer — turn the thinking "
            "switch off, or raise the response length",
        )

    if finish_reason == "length":
        yield {"type": "truncated"}

    tok_s = (completion_tokens / dt) if (completion_tokens and dt > 0) else None
    ttft = f"{first_token_ms:.0f} ms" if first_token_ms is not None else "n/a"
    log_bus.emit(
        "success",
        f"chat done · {len(text)} chars · {completion_tokens or '?'} tok · "
        f"first token {ttft} · {dt:.2f}s",
    )
    metrics.record(
        model, "chat", dt * 1000, throughput=tok_s, unit="tok/s", detail=f"{len(text)} chars"
    )
    yield {
        "type": "done",
        "text": text,
        "seconds": round(dt, 2),
        "tokens": completion_tokens,
        "firstTokenMs": round(first_token_ms) if first_token_ms is not None else None,
        "truncated": finish_reason == "length",
    }


def _looks_like_template_refusal(message: str) -> bool:
    low = message.lower()
    return "template" in low or "chat_template_kwargs" in low or "enable_thinking" in low
