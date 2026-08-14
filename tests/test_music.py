"""Tests for the two pure halves of the Music tab.

Everything covered here fails *silently*. A misspelled option key does not
raise — audio.cpp ignores unknown request options, so the BPM you typed simply
never reaches the model and the track comes back at some other tempo. An
enhancement reply wrapped in a code fence does not raise either — it degrades to
"the whole reply became the caption", and the metadata fields quietly stay empty.
Neither shows up as an error anywhere.

The seed rules are here for the same reason: an omitted seed makes a take
unreproducible, and repeating one seed across four takes renders the same file
four times. Both look like working software.

    .venv\\Scripts\\python -m pytest tests
"""

import pytest

import music
import music_prompt


# --- seeds -----------------------------------------------------------------


def test_seeds_are_always_explicit():
    """audio.cpp rolls its own seed when a request omits one and never reports
    it back, so a take rendered without an explicit seed can never be repeated."""
    seeds = music.resolve_seeds(None, 3)
    assert len(seeds) == 3
    assert all(isinstance(s, int) and 0 <= s < 2**31 - 1 for s in seeds)


def test_pinned_seed_walks_across_takes():
    """Four takes of one seed would be four identical files."""
    assert music.resolve_seeds(1000, 4) == [1000, 1001, 1002, 1003]
    assert len(set(music.resolve_seeds(1000, 4))) == 4


# --- request building ------------------------------------------------------


def _req(**spec):
    return music.build_request({"caption": "warm lo-fi guitar", **spec}, seed=7)


def test_caption_is_required():
    with pytest.raises(music.MusicError):
        music.build_request({"caption": "   "}, seed=1)


def test_metadata_lands_in_options_with_the_names_audiocpp_expects():
    """These keys are the contract with ace_step's request parser; a typo here
    is accepted by the server and then ignored."""
    req = _req(bpm=84, keyscale="Am", timeSignature="4/4", negativePrompt="harsh")
    assert req["options"] == {
        "bpm": "84",
        "keyscale": "Am",
        "timesignature": "4/4",
        "negative_prompt": "harsh",
    }


def test_bpm_keeps_its_integer_spelling():
    """A BPM that stringifies as "84.0" is not a BPM the parser recognises."""
    assert _req(bpm=84.0)["options"]["bpm"] == "84"


def test_unset_metadata_is_not_sent():
    """Blank means "let ACE-Step's planner infer it" — sending a default here
    would silently take that away."""
    assert "options" not in _req()


def test_auto_duration_is_omitted_rather_than_sent_as_minus_one():
    assert "duration_seconds" not in _req(durationSeconds=-1)
    assert _req(durationSeconds=90)["duration_seconds"] == 90.0


def test_planner_options_are_prefixed_lm():
    """ACE-Step's internal planner LM — not the llama.cpp model that wrote the
    caption. The two are easy to confuse and impossible to tell apart later."""
    req = _req(planner={"temperature": 0.7, "cfgScale": 2.0, "topK": 0, "topP": 0.9})
    # The options map is string-to-string on the C++ side, and a whole number
    # keeps its integer spelling — "2", not "2.0".
    assert req["options"] == {
        "lm_temperature": "0.7",
        "lm_cfg_scale": "2",
        "lm_top_k": "0",
        "lm_top_p": "0.9",
    }


def test_audio_routes_require_source_audio():
    for route in ("cover", "repaint", "extract", "lego"):
        with pytest.raises(music.MusicError):
            music.build_request({"caption": "x", "route": route}, seed=1)


def test_repaint_needs_a_valid_window():
    base = {"caption": "x", "route": "repaint"}
    with pytest.raises(music.MusicError):
        music.build_request(base, seed=1, audio_path="a.wav")
    with pytest.raises(music.MusicError):
        music.build_request({**base, "repaintStart": 20, "repaintEnd": 20}, seed=1, audio_path="a.wav")
    req = music.build_request(
        {**base, "repaintStart": 20, "repaintEnd": 35}, seed=1, audio_path="a.wav"
    )
    assert (req["repaint_start"], req["repaint_end"], req["audio"]) == (20.0, 35.0, "a.wav")


def test_text2music_ignores_source_audio():
    """The route ignores it upstream; sending it anyway only makes the logged
    request disagree with what was actually used."""
    assert "audio" not in music.build_request({"caption": "x"}, seed=1, audio_path="a.wav")


# --- enhancement parsing ---------------------------------------------------


def test_fenced_json_is_still_json():
    """Models asked for JSON habitually wrap it in ```json. Missing this turns a
    perfectly good structured reply into a caption full of braces."""
    parsed = music_prompt._extract_json('```json\n{"caption": "warm lo-fi"}\n```')
    assert parsed == {"caption": "warm lo-fi"}


def test_json_with_prose_around_it_is_recovered():
    parsed = music_prompt._extract_json('Sure! {"caption": "warm lo-fi"} Hope that helps.')
    assert parsed == {"caption": "warm lo-fi"}


def test_non_json_returns_none_so_the_caller_can_fall_back():
    assert music_prompt._extract_json("just a sentence about music") is None
    assert music_prompt._extract_json("") is None


def test_coerce_keeps_known_fields_and_types():
    fields = music_prompt._coerce(
        {
            "caption": "  warm lo-fi  ",
            "bpm": "84",
            "durationSeconds": "180",
            "keyscale": "Am",
            "nonsense": "dropped",
            "title": "",
        },
        with_lyrics=True,
    )
    assert fields == {"caption": "warm lo-fi", "keyscale": "Am", "bpm": 84, "durationSeconds": 180.0}


def test_coerce_renames_the_time_signature_to_the_spec_field():
    """The model is asked for `timesignature` (audio.cpp's own option key) but a
    client spec calls it `timeSignature`, and `fields` is spread straight into
    the caller's draft — under the wrong name it is silently dropped."""
    fields = music_prompt._coerce({"caption": "x", "timesignature": "3/4"}, with_lyrics=True)
    assert fields["timeSignature"] == "3/4"
    assert "timesignature" not in fields


def test_instrumental_wins_over_an_eager_model():
    """The switch is the user's instruction; a model that writes verses anyway
    must not silently put a vocal on an instrumental track."""
    fields = music_prompt._coerce({"caption": "x", "lyrics": "[Verse]\nla la"}, with_lyrics=False)
    assert fields["lyrics"] == "[Instrumental]"
