import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  CopyButton,
  Grid,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconFileMusic,
  IconInfoCircle,
  IconUpload,
  IconVolume,
  IconWriting,
  IconX,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import { fileToWavUpload, isProbablyVideo } from "../lib/wav";
import type { DiscoveredModel, MediaSupport, TranscribeResult, TranscriptWord } from "../types";
import { MicRecorder } from "./MicRecorder";
import { ModelSelect } from "./ModelSelect";
import { TextPlayer } from "./TextPlayer";
import { VoicePicker, type VoiceValue } from "./VoicePicker";

/** m:ss for short clips, h:mm:ss once a recording runs past an hour. */
function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const mm = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  const hh = Math.floor(s / 3600);
  return hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

interface Props {
  models: DiscoveredModel[];
  registeredIds: string[];
  serverRunning: boolean;
}

/** Transcript with word-level playback highlighting (karaoke style). */
function KaraokeTranscript({ words, audioUrl }: { words: TranscriptWord[]; audioUrl: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const rafRef = useRef(0);
  const [active, setActive] = useState(-1);

  const update = () => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.currentTime;
    let idx = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start > t) break;
      if (t < words[i].end) {
        idx = i;
        break;
      }
    }
    setActive(idx);
  };

  const loop = () => {
    update();
    const a = audioRef.current;
    if (a && !a.paused && !a.ended) rafRef.current = requestAnimationFrame(loop);
  };

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const seekTo = (w: TranscriptWord) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = w.start + 0.001;
    void a.play();
  };

  return (
    <Stack gap="sm">
      <audio
        ref={audioRef}
        controls
        src={audioUrl}
        style={{ width: "100%", height: 36 }}
        onPlay={() => {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(loop);
        }}
        onPause={() => cancelAnimationFrame(rafRef.current)}
        onSeeked={update}
        onEnded={() => setActive(-1)}
      />
      <Text component="div" style={{ lineHeight: 2 }}>
        {words.map((w, i) => (
          <span key={i}>
            <span
              onClick={() => seekTo(w)}
              title={`${w.start.toFixed(2)}s – ${w.end.toFixed(2)}s`}
              style={{
                cursor: "pointer",
                padding: "2px 3px",
                borderRadius: 4,
                transition: "background-color 120ms ease",
                backgroundColor: i === active ? "var(--mantine-color-grape-filled)" : undefined,
                color: i === active ? "var(--mantine-color-white)" : undefined,
              }}
            >
              {w.word}
            </span>{" "}
          </span>
        ))}
      </Text>
      <Text size="xs" c="dimmed">
        Click a word to jump there.
      </Text>
    </Stack>
  );
}

/** ASR (and its Silero VAD chunker) works at 16 kHz — everything is resampled to this. */
const ASR_RATE = 16000;

export function AsrPanel({ models, registeredIds, serverRunning }: Props) {
  const asrModels = models.filter((m) => m.task === "asr" && m.family);
  const [modelId, setModelId] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ uploadId: string; name: string; durationSec?: number | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  /** Upload progress 0..1 while sending a video, then null while ffmpeg runs. */
  const [progress, setProgress] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [result, setResult] = useState<TranscribeResult | null>(null);
  const [source, setSource] = useState<"file" | "record">("file");
  const [support, setSupport] = useState<MediaSupport | null>(null);
  const [mode, setMode] = useState<"text" | "karaoke">(
    () => (localStorage.getItem("asrMode") === "text" ? "text" : "karaoke"),
  );
  const model = asrModels.find((m) => m.id === modelId);

  // "Read it aloud": a separate model/voice choice from the ASR one above, kept
  // in its own storage slot so it doesn't fight with the TTS tab's selection.
  const [speakModelId, setSpeakModelId] = useState<string | null>(null);
  const [speakVoice, setSpeakVoice] = useState<VoiceValue>({ mode: "clone" });
  const speakModel = models.find((m) => m.id === speakModelId);

  // Whether the backend has ffmpeg decides if video files are offered at all.
  useEffect(() => {
    api.getMediaSupport().then(setSupport).catch(() => setSupport(null));
  }, []);

  if (asrModels.length === 0) {
    return (
      <Alert icon={<IconInfoCircle size={18} />} color="blue" variant="light" title="No ASR model downloaded">
        Download a speech-recognition model first, then rescan. For example:
        <Code block mt="sm">
          cd E:\LLM\audio\audio.cpp{"\n"}
          python tools/model_manager.py install qwen3_asr_0_6b
        </Code>
      </Alert>
    );
  }

  /**
   * Send a file straight to the backend so ffmpeg can pull the audio out — the
   * browser can't decode a video container, and shipping a big file needs a
   * progress bar.
   */
  async function uploadViaServer(file: File) {
    setStage("Uploading…");
    setProgress(0);
    const res = await api.upload(file, {
      rate: ASR_RATE,
      onProgress: (f) => {
        setProgress(f);
        // Once the bytes are all sent, ffmpeg is what we're waiting on.
        if (f >= 1) setStage("Extracting audio…");
      },
    });
    return res;
  }

  async function onDrop(files: File[]) {
    const file = files[0];
    if (!file) return;
    if (isProbablyVideo(file) && support && !support.ffmpeg) {
      notifications.show({
        color: "yellow",
        title: "Video needs ffmpeg",
        message: "Install ffmpeg on the PC (or set [media].ffmpeg in config.toml) to transcribe video files.",
      });
      return;
    }
    setUploading(true);
    try {
      // Plain audio decodes faster in the browser than it uploads; only video
      // (and anything AudioContext chokes on) makes the round trip.
      let res;
      if (isProbablyVideo(file)) {
        res = await uploadViaServer(file);
      } else {
        try {
          setStage("Converting…");
          res = await api.upload(await fileToWavUpload(file, ASR_RATE));
        } catch {
          res = await uploadViaServer(file);
        }
      }
      setUpload({ uploadId: res.uploadId, name: res.originalName, durationSec: res.durationSec });
      setResult(null);
    } catch (err) {
      notifications.show({ color: "red", title: "Upload failed", message: (err as Error).message });
    } finally {
      setUploading(false);
      setStage(null);
      setProgress(null);
    }
  }

  async function transcribe() {
    if (!modelId || !upload) return;
    if (!serverRunning || !registeredIds.includes(modelId)) {
      notifications.show({ color: "yellow", message: "Start the server with this ASR model registered first." });
      return;
    }
    setTranscribing(true);
    try {
      const res = await api.transcribe({
        model: modelId,
        uploadId: upload.uploadId,
        timestamps: mode === "karaoke" && !!model?.timestamps,
      });
      setResult(res);
    } catch (err) {
      notifications.show({ color: "red", title: "Transcription failed", message: (err as Error).message });
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <Grid gap="md">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Paper withBorder p="md" radius="md">
          <Stack gap="md">
            <Title order={5}>Transcribe (ASR)</Title>
            <ModelSelect
              models={models}
              task="asr"
              registeredIds={registeredIds}
              serverRunning={serverRunning}
              value={modelId}
              onChange={setModelId}
            />
            <SegmentedControl
              fullWidth
              value={source}
              onChange={(v) => setSource(v as "file" | "record")}
              data={[
                { label: "Audio / video file", value: "file" },
                { label: "Microphone", value: "record" },
              ]}
            />

            {source === "file" ? (
              <>
                <Dropzone
                  onDrop={onDrop}
                  loading={uploading}
                  accept={["audio/*", "video/*"]}
                  maxFiles={1}
                  multiple={false}
                >
                  <Group justify="center" gap="md" mih={90} style={{ pointerEvents: "none" }}>
                    <Dropzone.Accept>
                      <IconUpload size={40} />
                    </Dropzone.Accept>
                    <Dropzone.Reject>
                      <IconX size={40} />
                    </Dropzone.Reject>
                    <Dropzone.Idle>
                      <IconFileMusic size={40} />
                    </Dropzone.Idle>
                    <Text size="sm">Drop an audio or video file to transcribe, or click to browse</Text>
                  </Group>
                </Dropzone>
                {support?.ffmpeg === false ? (
                  <Text size="xs" c="orange">
                    ffmpeg was not found on the PC — only .wav and formats the browser can decode will work.
                    Set <Code>[media].ffmpeg</Code> in config.toml to enable video.
                  </Text>
                ) : (
                  <Text size="xs" c="dimmed">
                    Video files (mp4, mkv, mov …) have their audio track extracted on the PC.
                  </Text>
                )}
              </>
            ) : (
              <MicRecorder
                targetRate={ASR_RATE}
                buttonLabel="Record from microphone"
                hint="Recording stops when you press Stop; it is transcribed as one piece."
                successMessage="Recording captured — press Transcribe."
                onUploaded={(u) => {
                  setUpload(u);
                  setResult(null);
                }}
              />
            )}

            {stage && (
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  {stage}
                </Text>
                {progress !== null && <Progress value={progress * 100} size="sm" animated={progress >= 1} />}
              </Stack>
            )}

            {upload && (
              <Text size="sm" c="teal">
                Audio: {upload.name}
                {upload.durationSec ? ` · ${formatDuration(upload.durationSec)}` : ""}
              </Text>
            )}
            {model?.timestamps && (
              <div>
                <SegmentedControl
                  size="xs"
                  data={[
                    { label: "Normal transcript", value: "text" },
                    { label: "Karaoke (word timing)", value: "karaoke" },
                  ]}
                  value={mode}
                  onChange={(v) => {
                    setMode(v as "text" | "karaoke");
                    localStorage.setItem("asrMode", v);
                  }}
                />
                <Text size="xs" c="dimmed" mt={4}>
                  {mode === "karaoke"
                    ? "Words are time-aligned for playback highlighting — but the text loses punctuation."
                    : "Full punctuated text, no playback highlighting."}
                </Text>
              </div>
            )}
            <Button
              leftSection={<IconWriting size={18} />}
              onClick={transcribe}
              loading={transcribing}
              disabled={!modelId || !upload || !serverRunning}
              size="md"
            >
              Transcribe
            </Button>
          </Stack>
        </Paper>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        {result != null && (
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between" mb="xs">
              <Title order={6}>Transcript</Title>
              <Group gap="xs">
                <CopyButton value={result.text}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? "Copied" : "Copy transcript"}>
                      <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} onClick={copy}>
                        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
                <Tooltip label="Download as .txt">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    onClick={() => {
                      const blob = new Blob([result.text], { type: "text/plain;charset=utf-8" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = `${(upload?.name ?? "transcript").replace(/\.[^.]*$/, "")}.txt`;
                      a.click();
                      URL.revokeObjectURL(a.href);
                    }}
                  >
                    <IconDownload size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
            {result.words.length > 0 && upload ? (
              <KaraokeTranscript words={result.words} audioUrl={api.uploadAudioUrl(upload.uploadId)} />
            ) : (
              <Text style={{ whiteSpace: "pre-wrap" }}>{result.text || "(empty)"}</Text>
            )}

            {/* Say it back in another voice. The transcript is already the text
                a reading would be made of, so this is the same job as the
                Library player — hence the shared TextPlayer. */}
            {result.text.trim() !== "" && (
              <Stack gap="sm" mt="md">
                <Group gap="xs">
                  <IconVolume size={16} />
                  <Title order={6}>Read it aloud</Title>
                </Group>
                <ModelSelect
                  models={models}
                  task="tts"
                  registeredIds={registeredIds}
                  serverRunning={serverRunning}
                  value={speakModelId}
                  onChange={setSpeakModelId}
                  storageKey="asr.speak.tts"
                />
                <VoicePicker model={speakModel} value={speakVoice} onChange={setSpeakVoice} />
                <TextPlayer
                  model={speakModel}
                  voice={speakVoice}
                  text={result.text}
                  registeredIds={registeredIds}
                  serverRunning={serverRunning}
                  hint="Speaks the transcript with the chosen model and voice."
                />
              </Stack>
            )}
          </Paper>
        )}
      </Grid.Col>
    </Grid>
  );
}
