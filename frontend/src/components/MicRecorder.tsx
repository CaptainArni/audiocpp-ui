import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Paper, Progress, Stack, Text } from "@mantine/core";
import { IconMicrophone, IconPlayerStopFilled, IconRefresh } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import { blobToWavFile } from "../lib/wav";

type State = "idle" | "requesting" | "recording" | "processing" | "recorded" | "error";

interface Props {
  onUploaded: (upload: { uploadId: string; name: string }) => void;
  /** Optional passage to display for the speaker to read aloud while recording. */
  prompt?: string;
  /** Resample the recording to this rate before upload (ASR needs 16 kHz). */
  targetRate?: number;
  buttonLabel?: string;
  /** Line under the level meter; the default is voice-cloning advice. */
  hint?: string;
  successMessage?: string;
  /** Stop automatically at this many seconds — MediaRecorder buffers in memory. */
  maxSeconds?: number;
}

/** Warn this long before [maxSeconds] that the recording is about to be cut off. */
const WARN_BEFORE_SEC = 60;

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export function MicRecorder({
  onUploaded,
  prompt,
  targetRate,
  buttonLabel = "Record from microphone",
  hint = "A few seconds of clean speech works best. Speak at a normal volume.",
  successMessage = "Recording captured and set as the reference clip.",
  maxSeconds = 30 * 60,
}: Props) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  function cleanupMeter() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setLevel(0);
  }

  function stopTracks() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // Every chunk stays in memory until the recording is encoded, so a runaway
  // recording is a real memory problem — cut it off at the cap.
  useEffect(() => {
    if (state === "recording" && elapsed >= maxSeconds) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, state, maxSeconds]);

  // Full teardown on unmount.
  useEffect(() => {
    return () => {
      cleanupMeter();
      stopTracks();
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setError(null);
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      // Live level meter tapped off the same stream.
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(100, Math.round(rms * 250)));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      // Recorder.
      chunksRef.current = [];
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => void finish(mimeType);
      recorderRef.current = recorder;
      recorder.start();

      setElapsed(0);
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
      setState("recording");
    } catch (err) {
      const e = err as DOMException;
      const msg =
        e?.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow mic access and try again."
          : e?.name === "NotFoundError"
            ? "No microphone was found on this device."
            : (err as Error).message || "Could not start recording.";
      setError(msg);
      setState("error");
      cleanupMeter();
      stopTracks();
    }
  }

  function stop() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      setState("processing");
      recorderRef.current.stop();
    }
    cleanupMeter();
    stopTracks();
  }

  async function finish(mimeType: string) {
    try {
      const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
      if (blob.size === 0) throw new Error("Recording was empty.");

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));

      const wavFile = await blobToWavFile(blob, "recording.wav", targetRate);
      const res = await api.upload(wavFile);
      onUploaded({ uploadId: res.uploadId, name: res.originalName });
      setState("recorded");
      notifications.show({ color: "teal", message: successMessage });
    } catch (err) {
      const msg = (err as Error).message || "Could not process the recording.";
      setError(msg);
      setState("error");
      notifications.show({ color: "red", title: "Recording failed", message: msg });
    }
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setError(null);
    setElapsed(0);
    setState("idle");
  }

  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  const showPrompt =
    !!prompt?.trim() && (state === "idle" || state === "requesting" || state === "recording");

  return (
    <Stack gap="xs">
      {showPrompt && (
        <Paper withBorder p="sm" radius="sm">
          <Text size="xs" c="dimmed" mb={4}>
            Read this aloud:
          </Text>
          <Text size="sm" style={{ fontFamily: "Georgia, serif", lineHeight: 1.45 }}>
            {prompt}
          </Text>
        </Paper>
      )}

      {state === "error" && error && (
        <Alert color="red" variant="light" title="Microphone">
          {error}
        </Alert>
      )}

      {(state === "idle" || state === "error") && (
        <Button
          leftSection={<IconMicrophone size={18} />}
          onClick={start}
          variant="light"
          color="red"
        >
          {buttonLabel}
        </Button>
      )}

      {(state === "requesting" || state === "recording") && (
        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="sm" c="red" fw={500}>
              {state === "requesting" ? "Requesting microphone…" : `Recording… ${mmss}`}
            </Text>
            <Button
              leftSection={<IconPlayerStopFilled size={16} />}
              onClick={stop}
              color="red"
              size="xs"
              disabled={state === "requesting"}
            >
              Stop
            </Button>
          </Group>
          <Progress value={level} color="red" transitionDuration={80} />
          <Text size="xs" c={elapsed >= maxSeconds - WARN_BEFORE_SEC ? "orange" : "dimmed"}>
            {elapsed >= maxSeconds - WARN_BEFORE_SEC
              ? `Recording stops automatically in ${maxSeconds - elapsed}s (${Math.round(maxSeconds / 60)} min limit).`
              : hint}
          </Text>
        </Stack>
      )}

      {state === "processing" && (
        <Text size="sm" c="dimmed">
          Processing recording…
        </Text>
      )}

      {state === "recorded" && (
        <Stack gap="xs">
          {previewUrl && (
            <audio controls src={previewUrl} style={{ width: "100%" }}>
              <track kind="captions" />
            </audio>
          )}
          <Button leftSection={<IconRefresh size={16} />} onClick={reset} variant="subtle" size="xs">
            Record again
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
