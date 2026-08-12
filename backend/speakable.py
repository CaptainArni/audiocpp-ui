"""Turn streaming chat output into something a TTS model should read aloud.

Two jobs, both needed by the Call tab and neither by anything else:

1. ``to_speakable`` strips what a model writes for a *screen*. The system prompt
   asks for plain prose, but models still emit ``**bold**``, bullet lists and the
   occasional emoji, and a TTS model reads every one of those out loud
   ("sternchen sternchen"). Prompting alone is not reliable, so this runs on
   every chunk regardless.

2. ``SentenceStreamer`` cuts the *growing* answer into speakable segments as it
   arrives. This is deliberately not ``lib/chunk.ts`` / ``Chunker.kt``: those
   split a complete, known text for a reading, optimising for even chunk sizes.
   This one optimises for latency — get the first clause to the synthesiser as
   early as possible and never wait for text that has not been generated yet.
   It lives on the backend so Studio and the Android app share one segmentation
   (they receive `speak` events, they do not compute them).
"""

import re

# --- markdown / screen-formatting removal -----------------------------------

_FENCE = re.compile(r"```.*?```", re.DOTALL)
_FENCE_OPEN = re.compile(r"```.*$", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_BARE_URL = re.compile(r"\b(?:https?://|www\.)\S+")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_QUOTE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
_RULE = re.compile(r"^\s{0,3}(?:[-*_]\s*){3,}$", re.MULTILINE)
_BULLET = re.compile(r"^\s{0,6}[-*+•]\s+")
_NUMBERED = re.compile(r"^\s{0,6}\d{1,2}[.)]\s+")
_TERMINAL = ".!?…:;"
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)
_BOLD_ITALIC = re.compile(r"(\*{1,3}|_{1,3})(\S(?:.*?\S)?)\1", re.DOTALL)
_STRIKE = re.compile(r"~~(.+?)~~", re.DOTALL)
_LEFTOVER_MARKS = re.compile(r"[*_`~]{1,3}")

# Symbol/pictograph ranges. Emoji read aloud as their CLDR name ("grinsendes
# Gesicht"), which is worse than silence in a conversation.
_EMOJI = re.compile(
    "[\U0001f000-\U0001faff\U00002600-\U000027bf\U0001f1e6-\U0001f1ff←-⇿⬀-⯿️‍]"
)


def _delist(text: str) -> str:
    """Drop list markers, and terminate the item so it is spoken as a sentence.

    Without the added full stop the items run together into one breathless line —
    and, worse, the segmenter finds no boundary in them at all and holds the
    whole list back until it hits the character ceiling.
    """
    lines = []
    for line in text.split("\n"):
        stripped = _NUMBERED.sub("", _BULLET.sub("", line), count=1)
        was_item = stripped != line
        stripped = stripped.rstrip()
        if was_item and stripped and stripped[-1] not in _TERMINAL:
            stripped += "."
        lines.append(stripped)
    return "\n".join(lines)


def to_speakable(text: str) -> str:
    """Strip screen formatting so the text can be read aloud verbatim."""
    if not text:
        return ""
    s = _FENCE.sub(" ", text)
    # A stream can end mid-fence; drop the dangling opener rather than speaking code.
    s = _FENCE_OPEN.sub(" ", s)
    s = _IMAGE.sub(" ", s)
    s = _LINK.sub(r"\1", s)
    s = _BARE_URL.sub(" ", s)
    s = _TABLE_ROW.sub(" ", s)
    s = _RULE.sub(" ", s)
    s = _HEADING.sub("", s)
    s = _QUOTE.sub("", s)
    s = _delist(s)
    s = _INLINE_CODE.sub(r"\1", s)
    s = _BOLD_ITALIC.sub(r"\2", s)
    s = _STRIKE.sub(r"\1", s)
    s = _LEFTOVER_MARKS.sub("", s)
    s = _EMOJI.sub("", s)
    s = re.sub(r"[ \t ]+", " ", s)
    s = re.sub(r"\s*\n\s*", "\n", s)
    return s.strip()


# --- incremental segmentation ----------------------------------------------

# Abbreviations whose trailing period is not a sentence end. German-leaning,
# matching the rest of this app's prompts.
_ABBREVIATIONS = (
    "z.b", "u.a", "d.h", "bzw", "ca", "usw", "etc", "vgl", "ggf", "inkl", "evtl",
    "bspw", "dr", "prof", "nr", "abb", "s", "vgl", "mr", "mrs", "st",
)

_SENTENCE_END = re.compile(r"[.!?…]+[\"'»”’)\]]*(?=\s|$)")
_CLAUSE_END = re.compile(r"[,;:–—][\"'»”’)\]]*(?=\s)")

MAX_CHARS = 320
"""Hard ceiling for one segment. Below `chunk.ts`'s 400 because a conversational
reply should reach the speaker in smaller pieces than a book paragraph."""

MIN_CHARS = 24
"""Shorter than this and a segment is a stutter, not a sentence — fold it in."""

FIRST_SEGMENT_MIN = 40
"""Past this many characters the *first* segment may end at a clause boundary.
The whole latency win of streaming is paid once, at the start of a turn: the
sooner the first clause reaches the synthesiser the sooner the caller hears
anything. Later segments wait for real sentence ends so the prosody is right."""


def _ends_with_abbreviation(text: str) -> bool:
    tail = text[-12:].lower().rstrip("\"'»”’)]")
    if not tail.endswith("."):
        return False
    word = re.split(r"[\s(]", tail[:-1])[-1]
    # "3." / "1996." — a numbered list item or a year, not a sentence end.
    if word and word[-1].isdigit():
        return True
    return word in _ABBREVIATIONS


class SentenceStreamer:
    """Feed raw content deltas in, get speakable segments out, in order.

    Stateful and single-use per turn. ``feed`` returns only segments that are
    certainly complete; whatever might still grow is held back until the next
    delta or until ``finish``.
    """

    def __init__(self) -> None:
        self._buf = ""
        self._emitted = 0

    @property
    def emitted(self) -> int:
        return self._emitted

    def feed(self, delta: str) -> list[str]:
        if not delta:
            return []
        self._buf += delta
        out: list[str] = []
        while True:
            cut = self._find_cut()
            if cut is None:
                break
            head, self._buf = self._buf[:cut], self._buf[cut:].lstrip()
            segment = to_speakable(head)
            if not segment:
                continue
            if len(segment) < MIN_CHARS and out:
                out[-1] = f"{out[-1]} {segment}"
                continue
            out.append(segment)
            self._emitted += 1
        return out

    def finish(self) -> list[str]:
        """Flush whatever is left once the stream has ended."""
        rest = to_speakable(self._buf)
        self._buf = ""
        if not rest:
            return []
        self._emitted += 1
        return [rest]

    def _find_cut(self) -> "int | None":
        buf = self._buf
        if not buf:
            return None

        # A paragraph break is always a boundary, and a cheap one to spot.
        para = buf.find("\n\n")
        if para > 0:
            return para

        for m in _SENTENCE_END.finditer(buf):
            end = m.end()
            if _ends_with_abbreviation(buf[:end]):
                continue
            return end

        # Nothing terminal yet. The first segment of a turn may leave early at a
        # clause boundary; later ones wait, so sentences are not chopped up.
        if self._emitted == 0 and len(buf) >= FIRST_SEGMENT_MIN:
            for m in _CLAUSE_END.finditer(buf):
                if m.end() >= FIRST_SEGMENT_MIN:
                    return m.end()

        # A model that never punctuates must not stall playback forever.
        if len(buf) >= MAX_CHARS:
            space = buf.rfind(" ", MIN_CHARS, MAX_CHARS)
            return space if space > 0 else MAX_CHARS
        return None
