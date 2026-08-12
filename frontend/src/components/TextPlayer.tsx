import { useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Group, Loader, Paper, Text, Tooltip } from "@mantine/core";
import {
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconPlayerStop,
} from "@tabler/icons-react";
import { api } from "../api";
import { chunkText } from "../lib/chunk";
import type { DiscoveredModel } from "../types";
import type { VoiceValue } from "./VoicePicker";

type PlayStatus = "idle" | "buffering" | "playing" | "paused" | "done" | "error";

interface Props {
  model: DiscoveredModel | undefined;
  voice: VoiceValue;
  /** The whole text to read; it is chunked internally. */
  text: string;
  registeredIds: string[];
  serverRunning: boolean;
  /** Line shown while idle, explaining what pressing play will do. */
  hint?: string;
}

/**
 * Reads a block of text aloud by chunking it and synthesizing chunk by chunk —
 * the current chunk plays while the next is generated, so audio starts almost
 * immediately however long the text is. Mirrors the Android engine.
 *
 * Shared by the Library (a saved reading) and Transcribe (speaking a transcript
 * back in another voice), because they are the same job: some text, a voice, and
 * playback that must not wait for the whole thing to render.
 */
export function TextPlayer({ model, voice, text, registeredIds, serverRunning, hint }: Props) {
  const [status, setStatus] = useState<PlayStatus>("idle");
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const [generated, setGenerated] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [chunkText_, setChunkText] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chunksRef = useRef<string[]>([]);
  const urlsRef = useRef<(string | null)[]>([]);
  const indexRef = useRef(0);
  const waitingRef = useRef<number | null>(null);
  const cancelRef = useRef(false);

  const revokeAll = () => {
    urlsRef.current.forEach((u) => u && URL.revokeObjectURL(u));
    urlsRef.current = [];
  };

  // Full teardown on unmount (also fires when the caller changes `key`).
  useEffect(() => {
    return () => {
      cancelRef.current = true;
      audioRef.current?.pause();
      revokeAll();
    };
  }, []);

  const payloadFor = (chunk: string) => ({
    model: model!.id,
    text: chunk,
    voiceId: voice.mode === "builtin" ? voice.voiceId : undefined,
    savedVoiceId: voice.mode === "clone" ? voice.savedVoiceId || undefined : undefined,
    params: {},
  });

  const playIndex = (i: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (i >= chunksRef.current.length) {
      setStatus("done");
      return;
    }
    indexRef.current = i;
    setIndex(i);
    setChunkText(chunksRef.current[i] ?? "");
    const url = urlsRef.current[i];
    if (!url) {
      waitingRef.current = i;
      setStatus("buffering");
      return;
    }
    audio.src = url;
    audio.currentTime = 0;
    void audio.play();
    setStatus("playing");
  };

  const generateFrom = async (startIdx: number) => {
    for (let i = startIdx; i < chunksRef.current.length; i++) {
      if (cancelRef.current) return;
      try {
        const { blob } = await api.tts(payloadFor(chunksRef.current[i]));
        if (cancelRef.current) return;
        urlsRef.current[i] = URL.createObjectURL(blob);
        setGenerated(i + 1);
        // The player stalled waiting for exactly this chunk — start it now.
        if (waitingRef.current === i) {
          waitingRef.current = null;
          playIndex(i);
        }
      } catch (err) {
        if (cancelRef.current) return;
        setError((err as Error).message || "generation failed");
        setStatus("error");
        return;
      }
    }
  };

  const start = () => {
    if (!model) {
      setError("Select a TTS model first.");
      setStatus("error");
      return;
    }
    if (!serverRunning || !registeredIds.includes(model.id)) {
      setError("Start the server and register this model first.");
      setStatus("error");
      return;
    }
    if (voice.mode === "builtin" && model.builtinVoices.length > 0 && !voice.voiceId) {
      setError("Pick a built-in voice.");
      setStatus("error");
      return;
    }
    if (voice.mode === "clone" && !voice.savedVoiceId) {
      setError("Pick a saved voice.");
      setStatus("error");
      return;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      setError("There is no text to read.");
      setStatus("error");
      return;
    }

    // Fresh session.
    cancelRef.current = false;
    revokeAll();
    chunksRef.current = chunks;
    urlsRef.current = new Array(chunks.length).fill(null);
    indexRef.current = 0;
    waitingRef.current = 0; // play chunk 0 as soon as it's ready
    setError(null);
    setTotal(chunks.length);
    setGenerated(0);
    setIndex(0);
    setChunkText(chunks[0]);
    setStatus("buffering");
    void generateFrom(0);
  };

  const stop = () => {
    cancelRef.current = true;
    audioRef.current?.pause();
    revokeAll();
    chunksRef.current = [];
    waitingRef.current = null;
    indexRef.current = 0;
    setStatus("idle");
    setIndex(0);
    setTotal(0);
    setGenerated(0);
    setChunkText("");
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (status === "playing") {
      audio?.pause();
      setStatus("paused");
    } else if (status === "paused") {
      void audio?.play();
      setStatus("playing");
    } else {
      // idle / done / error → start a new run.
      start();
    }
  };

  const canPrev = status !== "idle" && index > 0;
  const canNext = index + 1 < total && generated > index + 1;

  const active = status !== "idle";
  const playIcon = status === "playing" ? <IconPlayerPause size={22} /> : <IconPlayerPlay size={22} />;

  return (
    <Paper withBorder p="sm" radius="md">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} onEnded={() => playIndex(indexRef.current + 1)} style={{ display: "none" }} />
      <Group justify="space-between" mb={active ? "xs" : 0}>
        <Group gap="xs">
          <ActionIcon
            size="xl"
            radius="xl"
            variant="filled"
            onClick={togglePlay}
            disabled={status === "buffering" && !active}
          >
            {status === "buffering" ? <Loader size="xs" color="white" /> : playIcon}
          </ActionIcon>
          <Tooltip label="Previous chunk">
            <ActionIcon variant="light" size="lg" onClick={() => canPrev && playIndex(index - 1)} disabled={!canPrev}>
              <IconPlayerSkipBack size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Next chunk">
            <ActionIcon variant="light" size="lg" onClick={() => canNext && playIndex(index + 1)} disabled={!canNext}>
              <IconPlayerSkipForward size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Stop">
            <ActionIcon variant="light" color="red" size="lg" onClick={stop} disabled={!active}>
              <IconPlayerStop size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {active && (
          <Text size="sm" c="dimmed">
            Chunk {index + 1} / {total}
            {status === "buffering" ? " · generating…" : generated < total ? ` · ${generated}/${total} ready` : ""}
          </Text>
        )}
      </Group>

      {!active && hint && (
        <Text size="xs" c="dimmed" mt="xs">
          {hint}
        </Text>
      )}
      {status === "error" && error && (
        <Alert color="red" variant="light" mt="xs" title="Playback">
          {error}
        </Alert>
      )}
      {active && chunkText_ && (
        <Text size="sm" mt="xs" style={{ fontFamily: "Georgia, serif", lineHeight: 1.5 }} lineClamp={4}>
          {chunkText_}
        </Text>
      )}
    </Paper>
  );
}
