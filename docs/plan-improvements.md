# Plan — improvements for Studio and the Android app

> **Status: all of §1–§4 are implemented.** §5 (Silero, the WebSocket realtime
> path, offline conversation export, a llama-swap group for the chat model) is
> untouched and still worth what it says. §6 is still explicitly not worth doing.
>
> Four things were found while building these that the plan did not predict, all
> now fixed and pinned by tests:
>
> 1. **The segmenter cut inside fenced code.** A blank line *inside* a block
>    looked like a paragraph boundary, so the cut landed mid-code: the second
>    half was spoken as prose, and each remaining fragment looked like a fresh
>    dangling opener, announcing one snippet several times over. A fence is now
>    opaque.
> 2. **Spaced German abbreviations were never guarded.** The list held `z.b`,
>    but German sets these *spaced* — `z. B.`, `u. a.`, `d. h.` — so the common
>    form fell through and the assistant paused in the middle of "zum Beispiel".
> 3. **The system prompt banned code blocks**, which is why §4.6 looked like it
>    worked in isolation and failed against a real model: told not to fence, the
>    model wrote bare code as prose, and it was read out character by character.
>    The prompt now *asks* for fences.
> 4. **Warm-up never recorded metrics**, so telemetry called three freshly
>    loaded models cold — which would have left §4.1's own Free VRAM button
>    greyed out immediately after starting a call.
>
> Also hardened in passing: store ids arrive off the URL, and the resolved-parent
> check alone accepted `""` and `"."`. Both stores now share `_store_path`, whose
> character class is the real guard.


Written after building the Call feature end to end. Everything below is grounded
in something observed in this codebase, not a generic checklist; where an item is
a *suspicion* rather than a confirmed defect it says so.

Ranked by "what would I be embarrassed to leave broken", not by size.

Scope: `audiocpp-ui` and `audiocpp-android`.

---

## 1. Confirmed bugs

### 1.1 Switching tabs during a call hangs up the call — **Studio**

`CallPanel` tears the engine down on unmount:

```tsx
useEffect(() => () => engineRef.current?.hangUp(), []);
```

That looks safe, because Mantine keeps inactive panels mounted. It isn't:
`Tabs` defaults to `keepMounted: true` **with `keepMountedMode: "activity"`**, so a
hidden panel is wrapped in React 19's `<Activity>` — which *tears down and re-runs
effects while keeping refs and state*. This is the same mechanism `App.tsx` already
documents for the Monaco log panel.

So glancing at Telemetry mid-call stops the microphone, drops the audio and ends
the turn; coming back shows "Not in a call". The conversation is not recoverable.

**Fix:** the call must outlive the panel. Either hoist the engine to `App.tsx`
(like the Android app does — `ReaderApp` owns the playback engine precisely so it
survives Activity recreation), or set `keepMountedMode="display-none"` on the
`Tabs`. Hoisting is the honest fix and also enables §3.2. Tearing down only on a
real unmount (leaving the app) is the behaviour people expect from a call.

### 1.2 An interrupted turn leaves a dangling user message — **both**

`runTurn` appends the user's message immediately and the assistant's only on the
`done` event. Interrupt (or barge-in) before `done` and the history ends with a
user turn that was never answered; the next turn appends a second one. The model
then sees two consecutive user messages, and — worse — the part it already *said
out loud* is absent from its own context, so it happily repeats it.

**Fix:** on cancel, append what was actually spoken (`streamingText` up to the
last segment handed to the player) as the assistant message, or drop the unanswered
user message if nothing was spoken. ~15 lines in `callEngine.ts` and
`CallController.kt`, and it is the difference between interrupting feeling like a
conversation and feeling like a reset.

### 1.3 An error strands the call with no obvious way out — **both**

On failure the phase goes to `ERROR` and stays there. The orb has no handler in
that state, so the only routes back are *Redo* (non-obvious) or *End call*.

**Fix:** make `ERROR` recoverable — tapping the orb returns to `listening`, and a
transient failure (one bad segment) should not end the call at all. Label the
action, e.g. "Tap to keep talking".

### 1.4 Android ignores audio-focus loss

`CallPlayer` requests `AUDIOFOCUS_GAIN_TRANSIENT` but never registers an
`OnAudioFocusChangeListener`. An incoming phone call, a navigation prompt or
another media app does not stop the assistant talking over it.

**Fix:** attach a listener — `LOSS_TRANSIENT` → pause and gate the mic,
`LOSS` → hang up, `GAIN` → resume listening. This is also the hook for §2.1.

---

## 2. The biggest functional gap

### 2.1 An Android call dies when the screen locks

There is no foreground service for the call. `AudioTrack` is not a Media3 player,
so `PlaybackService` does not apply as-is (and per the existing note, starting a
foreground service without a connected `MediaController` crashes).

This is *the* thing that makes the phone version feel like a demo rather than a
feature: a call you cannot put in your pocket. It wants a small dedicated
`CallService` (`foregroundServiceType="microphone|mediaPlayback"`, a notification
with End / Mute), which is also where §1.4's focus listener belongs. Non-trivial:
Android 14 tightened `microphone` foreground-service rules, so it must be started
from a visible Activity.

---

## 3. Robustness — the parts with no safety net

### 3.1 Tests for the logic that is easy to get quietly wrong

Neither repo has a test suite. Most of the code is I/O and UI where that is a
defensible trade, but three pieces are pure functions whose bugs are *silent*:

- **`speakable.py`** — the abbreviation guard (`z. B.` must not split), the
  first-segment early flush, list termination, code-fence stripping. I verified
  these by hand at a REPL; nothing stops the next edit regressing them.
- **`chunk.ts` ↔ `Chunker.kt` ↔ `speakable.py`** — three chunkers, kept in step
  by comment only. A **shared JSON fixture** (input → expected chunks) asserted
  from pytest, vitest and a Kotlin unit test would turn "keep in sync" from a
  hope into a build failure.
- **`WavIo.unwrap` / `_wav_to_pcm`** — header parsing, where being wrong by 44
  bytes is an audible click rather than an exception.

Start with pytest on `speakable.py`; it is an afternoon and covers the riskiest
code in the call path.

### 3.2 Conversations are lost on reload — **both**

History lives only in client memory. Reload Studio, switch app on the phone, and
the conversation is gone. `POST /api/readings` can save a transcript, but as
*pages* — it cannot be resumed as a conversation.

A `/api/conversations` store mirroring `/api/readings` (same file-per-uuid shape,
~80 lines) would make calls resumable, shared between Studio and the phone, and
would give the phone something to show when it reconnects.

### 3.3 Long calls silently lose context

`[call].context_messages = 20` trims older turns with no summarisation and no
indication. Twenty turns in, the assistant quietly forgets the start of the
conversation. At minimum, show it ("earlier turns are no longer being sent");
better, summarise the dropped prefix into a system note.

---

## 4. Worthwhile UX polish

| # | Item | Where | Why |
|---|---|---|---|
| 4.1 | **Free VRAM button** — `POST /v1/tasks/unload_models` exists and is unused | Studio | Higgs alone is 20.6 GB and models never unload. On a box also running a 27B chat model this is a real corner to be backed into, with only a full server restart as the escape. |
| 4.2 | **The orb is not a button** — a `div` with `onClick`, no focus ring, no `aria-label`, unreachable by keyboard except the global Space/Esc handlers | Studio | It is the primary control of the screen. Making it a real `<button>` costs nothing. |
| 4.3 | **No language selector for the call** — `CallSettings.language` exists and is passed to ASR and TTS, but `CallPanel` never sets it | Studio | Android sends the global language; Studio sends nothing, so the two clients behave differently for no reason. Small and confusing. |
| 4.4 | **Per-turn call latency in Telemetry** — `metrics` records chat/tts/asr separately but not the turn | Studio | The Call tab shows the breakdown for the *last* turn only. Recording it would make "is it getting slower?" answerable. |
| 4.5 | **VAD sensitivity control** | both | The energy gate is fixed (`SPEECH_FACTOR = 2.8`). A noisy room or a quiet talker has no recourse but editing source. One slider, stored next to the other call flags. |
| 4.6 | **Code answers are spoken as nothing** — `to_speakable` strips fenced blocks entirely | Studio backend | Ask for code in a call and the reply is silence with visible text. Say "code block omitted" instead. |
| 4.7 | **Interrupt is invisible on the phone** while the assistant speaks | Android | Tapping the orb interrupts, but nothing says so. The desktop spells it out; the phone should too. |

---

## 5. Bigger things, if the appetite is there

- **A real VAD (Silero) behind the existing seam.** `VadOptions` / `MicVad` were
  written so the detector can be swapped. An energy gate is fine close-talk and
  poor across a room. Worth it only if hands-free proves annoying in practice —
  measure first.
- **The WebSocket realtime path** (§6 of `plan-voice-call.md`). Now that a
  streaming ASR model is installed, `/v1/audio/transcriptions/live` is finally
  reachable — but only from a native client or via the backend, since a browser
  cannot drive it. It would cut another ~500 ms and give partial transcripts
  *while* speaking. Large; the current shape is already ~1.2 s.
- **Offline export for conversations**, matching readings' `ExportStore`.
- **A llama-swap group for the chat model**, so running OCR mid-call does not
  evict it and cost a reload on the next turn.

---

## 6. Explicitly not worth doing

- **Unifying the three chunkers.** They optimise for different things (even sizes
  for a reading, latency for a stream). Fixture tests, not a merge.
- **Auth on the LAN path.** Deliberate, documented, and the Cloudflare Access
  route already covers remote use.
- **Media3 / lock-screen controls for the call.** ExoPlayer is the wrong
  primitive for headerless streaming PCM with instant stop; §2.1's own service is
  the right answer, not a retrofit.
- **Chasing TTS speed further.** 1.2 s to first sound is already dominated by
  human turn-taking (`vad_hangover_ms = 700`). Tuning the hangover is a bigger
  lever than any model change, and it is one config line.

---

## 7. Suggested order

1. **§1.1** (tab switch kills the call) — the one a user hits by accident today.
2. **§1.2 + §1.3** (interrupt context, error recovery) — same files, small, and
   together they make interruption feel designed rather than survived.
3. **§1.4** (audio focus) — small, and a prerequisite for §2.1.
4. **§3.1** (pytest for `speakable.py` + the shared chunker fixture) — before the
   next feature lands on top of untested logic.
5. **§4.1, §4.2, §4.3** — an afternoon of small, visible wins.
6. **§2.1** (Android foreground call) — the big one; do it when there is a
   half-day, and verify on a real device.
7. **§3.2** (conversation store) — once §1.1 has settled how a call is owned.
