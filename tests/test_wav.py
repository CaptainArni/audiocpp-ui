"""Tests for WAV handling in the call path.

Being wrong here is an audible click rather than an exception, which is exactly
why it is worth pinning: a header parsed 44 bytes deep on a file that happens to
carry a LIST chunk first sends metadata to the speaker as noise.
"""

import io
import struct
import sys
import wave
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import main  # noqa: E402  (needs the path set above)


def make_wav(frames: bytes, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()


def with_list_chunk(wav: bytes) -> bytes:
    """Splice a LIST chunk in before `data`, as some encoders do.

    This is the case that breaks a reader which assumes audio starts at byte 44.
    """
    at = wav.index(b"data")
    payload = b"INFOISFT" + struct.pack("<I", 6) + b"tests\x00"
    chunk = b"LIST" + struct.pack("<I", len(payload)) + payload
    out = wav[:at] + chunk + wav[at:]
    # RIFF size counts everything after the first 8 bytes.
    return out[:4] + struct.pack("<I", len(out) - 8) + out[8:]


# --- _wav_to_pcm ------------------------------------------------------------

def test_wav_to_pcm_returns_frames_and_rate():
    frames = b"\x01\x02" * 100
    pcm, rate = main._wav_to_pcm(make_wav(frames, 24000))
    assert pcm == frames
    assert rate == 24000


def test_wav_to_pcm_skips_a_leading_list_chunk():
    frames = b"\x7f\x00" * 50
    pcm, rate = main._wav_to_pcm(with_list_chunk(make_wav(frames)))
    assert pcm == frames, "metadata bytes reached the PCM stream"
    assert rate == 16000


def test_wav_to_pcm_on_an_empty_clip():
    pcm, rate = main._wav_to_pcm(make_wav(b""))
    assert pcm == b""
    assert rate == 16000


# --- _pad_wav_tail ----------------------------------------------------------

def test_pad_wav_tail_appends_silence(tmp_path):
    """A streaming ASR session discards its last partial window, so a turn ending
    "…und ein paar Eier da" came back as "…und ein paar" — the model then answers
    a question it never heard in full."""
    p = tmp_path / "utterance.wav"
    frames = b"\x11\x22" * 16000  # 1 s
    p.write_bytes(make_wav(frames))

    main._pad_wav_tail(p, seconds=1.0)

    with wave.open(str(p), "rb") as w:
        assert w.getframerate() == 16000
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        out = w.readframes(w.getnframes())
    assert out.startswith(frames), "the original audio was altered"
    assert out[len(frames):] == b"\x00" * 32000, "padding is not silence"


def test_pad_wav_tail_preserves_a_non_default_rate(tmp_path):
    p = tmp_path / "utterance.wav"
    p.write_bytes(make_wav(b"\x01\x00" * 8000, rate=8000))
    main._pad_wav_tail(p, seconds=0.5)
    with wave.open(str(p), "rb") as w:
        assert w.getframerate() == 8000
        assert w.getnframes() == 8000 + 4000


def test_pad_wav_tail_leaves_an_unreadable_file_alone(tmp_path):
    """Padding is a safeguard, not a requirement — a file we cannot rewrite must
    still reach the ASR model rather than blowing up the turn."""
    p = tmp_path / "broken.wav"
    p.write_bytes(b"not a wav at all")
    main._pad_wav_tail(p)  # must not raise
    assert p.read_bytes() == b"not a wav at all"


# --- id handling for the file-backed stores ---------------------------------

@pytest.mark.parametrize(
    "bad_id",
    ["../config", "..\\config", "a/../../secret", "sub/dir", "", "."],
)
def test_conversation_ids_cannot_escape_their_directory(bad_id):
    """The id comes straight off the URL, and the store is a file per uuid, so
    this is the only thing standing between a path and the rest of the disk."""
    with pytest.raises(ValueError):
        main._conversation_path(bad_id)


def test_a_normal_conversation_id_resolves_inside_the_store():
    p = main._conversation_path("0123456789abcdef")
    assert p.parent == main.cfg.conversations_dir.resolve()
    assert p.name == "0123456789abcdef.json"


@pytest.mark.parametrize("bad_id", ["../config", "..\\config", "sub/dir", "", "."])
def test_reading_ids_are_guarded_the_same_way(bad_id):
    """Same store shape, same exposure — hardening only one of the two would be
    worse than hardening neither, because it reads as if both were checked."""
    with pytest.raises(ValueError):
        main._reading_path(bad_id)


# --- _wav_duration ----------------------------------------------------------

def test_wav_duration_matches_the_frame_count():
    assert main._wav_duration(make_wav(b"\x00\x00" * 32000)) == pytest.approx(2.0)


def test_wav_duration_of_garbage_is_none():
    assert main._wav_duration(b"nope") is None
