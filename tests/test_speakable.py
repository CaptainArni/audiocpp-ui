"""Tests for the streaming segmenter — the riskiest pure code in the call path.

Everything here is a *silent* failure mode: a wrong cut does not raise, it just
makes the assistant pause mid-abbreviation, or hold the first sentence back for
a second, or announce a code block five times. Each test names the symptom it
guards, because the correct output on its own does not explain why.

This is deliberately not the same algorithm as `chunk.ts` / `Chunker.kt` (see
tests/fixtures/chunking.json): those split a *complete* text for even chunk
sizes, this one splits a *growing* one for latency.

    .venv\\Scripts\\python -m pytest tests
"""

import pytest

from speakable import (
    FIRST_SEGMENT_MIN,
    MAX_CHARS,
    MIN_CHARS,
    SentenceStreamer,
    to_speakable,
)

CODE = "Codeblock ausgelassen."


def stream(deltas, placeholder=""):
    """Feed deltas one at a time, exactly as chat.py does, and collect segments."""
    s = SentenceStreamer(placeholder)
    out = []
    for d in deltas:
        out += s.feed(d)
    return out + s.finish()


# --- to_speakable: screen formatting a TTS model would read out loud ---------

@pytest.mark.parametrize(
    "raw, expected",
    [
        ("**fett** und *kursiv*", "fett und kursiv"),
        ("~~gestrichen~~", "gestrichen"),
        ("Das ist `code` im Text", "Das ist code im Text"),
        ("## Überschrift", "Überschrift"),
        ("> ein Zitat", "ein Zitat"),
        ("[Anthropic](https://example.com) ist da", "Anthropic ist da"),
        ("Siehe https://example.com/x hier", "Siehe hier"),
        ("![Bild](x.png) danach", "danach"),
        ("Hallo 😀 Welt", "Hallo Welt"),
        ("---", ""),
        ("| a | b |\n| - | - |", ""),
    ],
)
def test_strips_what_would_be_read_aloud(raw, expected):
    assert to_speakable(raw) == expected


def test_list_items_get_a_full_stop():
    """Without it the items run together *and* the segmenter finds no boundary,
    so the whole list is held back to the character ceiling."""
    assert to_speakable("- Milch\n- Eier\n- Brot") == "Milch.\nEier.\nBrot."


def test_list_item_that_already_ends_in_punctuation_is_left_alone():
    assert to_speakable("1. Fertig!\n2. Schon.") == "Fertig!\nSchon."


def test_empty_input():
    assert to_speakable("") == ""


# --- code fences ------------------------------------------------------------

def test_code_fence_is_replaced_by_the_placeholder():
    assert to_speakable("Vorher.\n```py\nx = 1\n```\nNachher.", CODE) == (
        f"Vorher.\n{CODE}\nNachher."
    )


def test_code_fence_is_dropped_when_no_placeholder_is_configured():
    assert to_speakable("Vorher.\n```py\nx = 1\n```\nNachher.", "") == "Vorher.\nNachher."


def test_unterminated_fence_is_still_treated_as_code():
    """A stream can end mid-fence; speaking the half-written code is the one
    outcome that is worse than saying nothing."""
    assert to_speakable("Hier:\n```py\nx = 1", CODE) == f"Hier:\n{CODE}"


def test_code_block_is_announced_exactly_once_while_streaming():
    """The regression this guards: code is full of periods and newlines, so a
    segmenter that cuts inside the fence turns every fragment into another
    dangling opener — and a ten-line snippet gets announced five times."""
    segments = stream(
        [
            "Klar. Hier ist das Beispiel:\n\n```python\n",
            "def add(a, b):\n    return a + b.\n",
            "\nprint(add(1, 2))\n```\n\n",
            "Das war alles. Noch Fragen?",
        ],
        CODE,
    )
    joined = " ".join(segments)
    assert joined.count(CODE) == 1
    # A blank line *inside* the block used to look like a paragraph boundary, so
    # the cut landed mid-code and the second half was spoken as prose.
    assert "def add" not in joined
    assert "print" not in joined
    assert "Noch Fragen?" in joined


def test_segments_before_a_code_block_are_still_spoken_promptly():
    """The prose in front of a fence is complete — nothing more gets appended in
    front of it — so it must not wait for the block to close."""
    s = SentenceStreamer(CODE)
    out = s.feed("Gerne, so geht das:\n\n```python\ndef f():\n")
    assert out == ["Gerne, so geht das:"]
    # …and the still-open block is held rather than emitted piecemeal.
    assert s.feed("    return 1.\n") == []


# --- abbreviations ----------------------------------------------------------

@pytest.mark.parametrize(
    "text",
    [
        "Das gilt für Obst, z. B. Äpfel und Birnen, aber auch für anderes Obst.",
        "Der Betrag liegt bei ca. 40 Euro und damit klar über dem Durchschnitt.",
        "Wir treffen uns u. a. mit Dr. Meier und besprechen die weiteren Schritte.",
    ],
)
def test_abbreviations_do_not_end_a_sentence(text):
    assert stream([text]) == [text]


def test_a_number_followed_by_a_period_does_not_end_a_sentence():
    text = "Das Haus wurde 1996. Es steht heute noch dort am Rand des Dorfes."
    assert stream([text])[0].startswith("Das Haus wurde 1996. Es steht")


def test_a_real_sentence_end_after_an_abbreviation_still_cuts():
    out = stream(["Das war ca. 40 Euro wert im letzten Jahr. Danach wurde es teurer."])
    assert out == ["Das war ca. 40 Euro wert im letzten Jahr. Danach wurde es teurer."]


# --- latency: the first segment ---------------------------------------------

def test_first_segment_may_leave_at_a_clause_boundary():
    """The whole latency win is paid once, at the start of a turn: the first
    clause should reach the synthesiser without waiting for a full stop."""
    out = SentenceStreamer().feed(
        "Ja, das kann ich sehr gerne für dich machen, und zwar noch heute Nachmittag"
    )
    assert out == ["Ja, das kann ich sehr gerne für dich machen,"]
    assert len(out[0]) >= FIRST_SEGMENT_MIN


def test_later_segments_wait_for_a_real_sentence_end():
    """Chopping every clause would wreck the prosody once audio is already
    flowing, and by then there is nothing left to gain."""
    s = SentenceStreamer()
    assert s.feed("Ja, das mache ich gerne für dich, und zwar sofort.") != []
    assert s.feed(" Danach schaue ich mir das an, wenn ich Zeit habe") == []


def test_a_short_first_clause_is_not_cut():
    assert SentenceStreamer().feed("Ja, klar") == []


# --- runts, ceilings and flushing -------------------------------------------

def test_short_fragments_are_folded_into_the_previous_segment():
    out = stream(["Der Zug fährt gleich ab vom Gleis sieben. Beeil dich! Wirklich!"])
    assert len(out) == 1
    assert out[0].endswith("Beeil dich! Wirklich!")


def test_unpunctuated_output_still_gets_cut_at_the_ceiling():
    """A model that never punctuates must not stall playback forever."""
    out = stream(["wort " * 200])
    assert out, "nothing was emitted at all"
    assert all(len(seg) <= MAX_CHARS for seg in out)


def test_finish_flushes_the_tail():
    s = SentenceStreamer()
    assert s.feed("Ein Satz. Und ein unvollendeter") == ["Ein Satz."]
    assert s.finish() == ["Und ein unvollendeter"]


def test_finish_on_an_empty_buffer_emits_nothing():
    assert SentenceStreamer().finish() == []


def test_emitted_counts_only_real_segments():
    s = SentenceStreamer()
    s.feed("```\ncode\n")  # held, not emitted
    assert s.emitted == 0


def test_paragraph_break_is_a_boundary():
    assert stream(["Erster Absatz\n\nZweiter Absatz"]) == ["Erster Absatz", "Zweiter Absatz"]


def test_whitespace_only_stream_emits_nothing():
    assert stream(["   ", "\n\n", "  "]) == []


def test_min_chars_is_below_first_segment_min():
    """A first segment shorter than MIN_CHARS would be folded away immediately,
    which would silently undo the early-flush optimisation."""
    assert MIN_CHARS < FIRST_SEGMENT_MIN < MAX_CHARS
