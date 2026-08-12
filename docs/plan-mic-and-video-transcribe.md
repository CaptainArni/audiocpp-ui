# Plan — mic recording + video audio for Transcribe (Studio & Android)

Adds two input sources to the ASR flow in both clients: **record from microphone**
and **audio extracted from a video file**. The conversion work lands in one new
backend module so neither client has to know about codecs.

Scope: `audiocpp-ui` (backend + frontend) and `audiocpp-android`.

---

## 0. Where things stand today

| | Studio | Android |
|---|---|---|
| Transcribe UI | `AsrPanel.tsx` — Dropzone only | **none** |
| Mic capture | `MicRecorder.tsx` exists, wired only into voice cloning | `WavRecorder.kt` exists (48 kHz, hardcoded), voice cloning only |
| Audio decode | `lib/wav.ts` → `AudioContext.decodeAudioData`, client-side | `WavRecorder` writes RIFF by hand |
| Video | not supported (`accept` lists `video/webm` but `decodeAudioData` fails on real containers) | not supported |
| Upload | `POST /api/uploads` — **rejects any filename not ending `.wav`** | same endpoint, `uploadWav` |
| ASR call | `POST /api/transcribe` | **not implemented in `Api.kt`** |

`ffmpeg` 8.1.1 (Gyan full build) is already on PATH on this machine.

---

## 1. Backend — the shared conversion point (`audiocpp-ui/backend`)

### 1.1 `config.toml` — new `[media]` section

```toml
[media]
# Blank => resolve "ffmpeg"/"ffprobe" from PATH.
ffmpeg = ""
ffprobe = ""
# Reject media longer than this before spending time on it (ASR is one request).
max_duration_sec = 3600
# Hard cap on a single upload body.
max_upload_mb = 2048
# Uploads are transient; prune converted WAVs older than this on startup + after
# each upload. Video-derived audio is large (1 h @ 16 kHz mono = ~115 MB).
uploads_retention_hours = 24
```

`config.py` gains matching properties (`media_ffmpeg`, `media_max_duration_sec`, …),
following the existing property style.

### 1.2 New `backend/media.py`

- `MediaError(Exception)` — client-facing message; maps to HTTP 400 via `_fail`.
- `ffmpeg_path()` / `ffprobe_path()` — config value, else `shutil.which`, cached.
- `probe(path) -> {durationSec, hasAudio, hasVideo, format, codec}` via
  `ffprobe -v error -show_streams -show_format -of json`.
- `to_wav(src: Path, dst: Path, rate: int = 16000)` — runs
  `ffmpeg -nostdin -v error -y -i <src> -vn -ac 1 -ar <rate> -c:a pcm_s16le <dst>`.
  - `creationflags=CREATE_NO_WINDOW` on Windows, mirroring `process.py`.
  - stderr captured and emitted to `log_bus` on failure (`source="app"`, level `error`);
    success emits an `info` line with duration + wall time.
  - no shell, argument list only.
- `prune_uploads(dir, retention_hours)`.

### 1.3 `POST /api/uploads` — accept any media

Replace the extension check with:

1. Stream the body to `uploads/<uuid><ext>` in chunks (**not** `await file.read()` —
   a 1 GB video must not land in RAM), aborting past `max_upload_mb`.
2. If the name ends `.wav` **and** no `rate` form field was sent → keep as-is.
   *This preserves today's behaviour byte-for-byte for the Android voice-clip path
   and the Studio client-side WAV path.*
3. Otherwise `probe()`; reject `hasAudio == false` ("this file has no audio track")
   and `durationSec > max_duration_sec`; then `to_wav(..., rate)` → `<uuid>.wav`,
   delete the source.
4. Response grows: `{uploadId, path, originalName, durationSec, converted, sourceKind}`
   where `sourceKind ∈ audio|video|wav`.

New optional form field `rate` (int). ASR callers send `16000`; the voice-clone
path sends nothing (or `48000`) so reference clips are not downsampled.

### 1.4 `GET /api/media/support`

`{ffmpeg: bool, version: str|null, maxDurationSec, maxUploadMb}` — lets both UIs
disable the video affordance with a real explanation instead of failing at upload
time. Cheap, cached.

### 1.5 Housekeeping

- `prune_uploads` called in the `lifespan` startup and after each successful upload.
- `proxy.transcribe` already uses `httpx` `timeout=600`; that is ~10 min of wall
  clock for the ASR itself. Make it `[media].asr_timeout_sec` (default 900) so a
  long lecture does not die at the proxy.

---

## 2. Studio frontend (`audiocpp-ui/frontend/src`)

### 2.1 `api.ts` / `types.ts`

- `upload(file, opts?: {rate?: number, onProgress?: (frac) => void})`.
  Progress needs **`XMLHttpRequest`** (`fetch` has no upload progress) — add a small
  `uploadWithProgress` helper; keep the plain `fetch` path when no callback is given.
- `getMediaSupport(): Promise<MediaSupport>`.
- `UploadResult` gains `durationSec?`, `converted?`, `sourceKind?`; new `MediaSupport`
  type. Keep `types.ts` in sync with the backend shapes, per repo convention.

### 2.2 `lib/wav.ts`

- `fileToWavUpload` keeps the fast client-side path for plain audio.
- New `isProbablyVideo(file)` (mime `video/*`, or extension in
  `mp4 mkv m4v mov avi webm ts flv wmv`).

### 2.3 `MicRecorder.tsx` — make it reusable

It is currently hard-wired for voice cloning. Add props, no behaviour change for
the existing caller:

- `targetRate?: number` → passed to `blobToWavFile` (AsrPanel passes `16000`;
  the ASR pipeline's Silero VAD chunker wants exactly 16 kHz).
- `successMessage?: string` — replaces the hardcoded
  "…set as the reference clip." copy.
- `buttonLabel?: string`, `hint?: string`.
- Soft cap + warning banner past ~10 min (MediaRecorder holds every chunk in
  memory), and stop automatically at a hard cap.

### 2.4 `AsrPanel.tsx` — three sources

Replace the bare Dropzone with a `SegmentedControl`: **File · Record**.

- **File**: Dropzone `accept={["audio/*", "video/*"]}`, copy "Drop an audio or
  video file". `onDrop` routes:
  - video (or client-side decode throws) → `api.upload(file, {rate: 16000, onProgress})`,
    server-side ffmpeg, with a `Progress` bar for the upload and a "Extracting
    audio…" state after;
  - plain audio → existing `fileToWavUpload(file, 16000)`, unchanged (fast, no
    round trip).
  - If `/api/media/support` says no ffmpeg, video files are rejected in the
    Dropzone with the reason.
- **Record**: `<MicRecorder targetRate={16000} …/>`. It already reports
  `{uploadId, name}`, exactly the shape `AsrPanel`'s `upload` state holds — drops in.
- Show `durationSec` next to the chosen source so a wrong file is obvious before
  a 10-minute transcription.
- **Karaoke needs no change**: `api.uploadAudioUrl(uploadId)` serves the converted
  16 kHz WAV, so word highlighting works for video-derived and recorded audio too.
  (The video's picture is not shown — deliberately out of scope.)

---

## 3. Android (`audiocpp-android`)

The phone gets a real Transcribe feature, which it does not have today.

### 3.1 `data/Api.kt`

- `data class TranscriptWord(word, start, end)`, `data class TranscribeResult(text, language, words)`.
- `transcribe(model, uploadId, language, timestamps): TranscribeResult` → `POST /api/transcribe`.
- `uploadMedia(file: File|InputStream, filename, mime, rate: Int?): UploadResult` —
  multipart with a **progress-counting `RequestBody`** wrapper so a large upload
  is not a frozen spinner.
- `mediaSupport(): MediaSupport`.
- **Timeout**: the shared client's 240 s read timeout will kill a long
  transcription. Use a per-call `client.newBuilder().readTimeout(15, MINUTES)`
  for `transcribe` and for `uploadMedia`.
- ASR models come from the existing `models()` (it already returns `task`) —
  filter `task == "asr"` client-side.

### 3.2 `audio/WavRecorder.kt`

Turn `SAMPLE_RATE` from a `companion object const` into a constructor parameter
defaulting to `48_000`, so voice recording is untouched and ASR can request
`WavRecorder(16_000)`. `AudioRecord` supports 16 kHz mono on every device.

### 3.3 Video → audio on the phone: `audio/MediaAudioExtractor.kt`

**Recommended: extract on-device, fall back to the server.**

- Primary: `MediaExtractor` selects the audio track → `MediaCodec` decodes to PCM →
  downmix to mono → linear resample to 16 kHz → RIFF header (reuse `WavRecorder`'s
  `wrapWav`, lifted into a shared `WavIo` helper). ~150 lines.
  *Why:* uploading the raw video is the problem, not the decode. A 1 GB movie over
  Wi-Fi is minutes of waiting, and the Cloudflare Access path (`Settings.accessToken`)
  has a request-body cap (100 MB on the free plan) that a video will blow through.
  Extracted 16 kHz mono is ~2 MB/minute.
- Fallback: no decoder for the track (MKV, exotic codecs Android cannot decode) →
  upload the original file to `/api/uploads` and let the PC's ffmpeg do it, with an
  explicit "sending the file to the PC — this may take a while" state. The backend
  endpoint exists for Studio anyway, so this fallback is nearly free.

File picking: `ActivityResultContracts.OpenDocument` with
`arrayOf("audio/*", "video/*")` — SAF, so **no storage permission** and no manifest
change. `RECORD_AUDIO` is already requested up front in `MainActivity`.

### 3.4 `data/Settings.kt`

New `asrModel` pref (mirrors `ttsModel`), blank => first `task == "asr"` model.

### 3.5 `ReaderViewModel.kt`

- `UiState` gains `asrModel`, `asrModels`, `transcribing: String?` (stage label:
  Extracting… / Uploading… / Transcribing…), `transcribeProgress: Float?`,
  `transcript: String?`, `transcriptLanguage: String?`.
- `startAsrRecording()` / `stopAsrRecordingAndTranscribe()` using a second
  `WavRecorder(16_000)` instance (the existing `recorder` stays the 48 kHz voice one).
- `transcribeUri(uri: Uri)` — extract → upload → transcribe.
- `saveTranscriptAsReading(name)` → `api.createReading(name, pages = [transcript])`.

### 3.6 `ui/TranscribeScreen.kt` + 5th nav tab

New tab between Library and Voices, icon `Icons.Default.GraphicEq`. Material 3
`NavigationBar` handles 5 items.

- Source row: **Record** (level meter + mm:ss, reusing the `VoicesScreen` recorder
  visuals) and **Pick audio/video**.
- Stage indicator with the progress fraction during upload.
- Result card: the text, **Copy**, **Share** (`ACTION_SEND`), and **Save as reading** —
  which is the real payoff: transcribe a lecture on the phone, save it to the shared
  Library, then play it back through a cloned voice with the existing engine.
- Model + language picked up from Settings; a hint linking to Settings when no ASR
  model is downloaded.

Word-level karaoke playback on the phone is **deferred** — it needs the converted
audio pulled back from the server plus a second player alongside `PlaybackEngine`.

---

## 4. Build order

1. `media.py` + `[media]` config + `/api/uploads` rewrite + `/api/media/support`.
   Verify with `curl` on an `.mp4` and an `.mp3`.
2. Studio `api.ts`/`types.ts`/`wav.ts` plumbing → `MicRecorder` props →
   `AsrPanel` rework. Gate: `cd frontend; npx tsc --noEmit`, then `scripts\build.bat`.
3. Android `Api.kt` + `WavRecorder` param + `Settings.asrModel`.
4. `MediaAudioExtractor` (+ server fallback).
5. `ReaderViewModel` + `TranscribeScreen` + nav tab.
   Gate: `.\gradlew.bat compileDebugKotlin`.
6. Update both `CLAUDE.md`s (uploads are no longer WAV-only; new tab; new module)
   and both `README`s.

## 5. Risks / decisions worth confirming

- **`/api/uploads` semantics change.** Widening the existing endpoint keeps both
  API clients simple, and the `.wav`-passthrough short-circuit means the voice-clone
  path is unaffected. The alternative — a separate `/api/uploads/media` — is more
  conservative but duplicates the client plumbing.
- **ffmpeg becomes a soft dependency.** Absent ffmpeg, everything works exactly as
  today; only video is unavailable, and `/api/media/support` says so.
- **Long media.** ASR is one non-streaming request. `max_duration_sec` (1 h) plus
  the raised proxy/OkHttp timeouts keep it honest, but a 1 h file is a multi-minute
  wait with no partial output. Chunked/streaming ASR is a separate, larger change.
- **Disk.** Converted WAVs are ~115 MB/hour; the new `uploads/` prune is what keeps
  `backend/uploads/` from growing without bound (it currently never cleans up).
- **Android on-device extraction vs. server-side.** On-device is ~150 lines of
  fiddly `MediaCodec`, but avoids shipping whole videos over Wi-Fi and past the
  Cloudflare body limit. If you would rather not carry that code, drop step 3.3's
  primary path and always use the server fallback — ~20 lines instead.
