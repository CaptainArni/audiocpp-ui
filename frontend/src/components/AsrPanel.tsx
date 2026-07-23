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
  IconWriting,
  IconX,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import { fileToWavUpload } from "../lib/wav";
import type { DiscoveredModel, TranscribeResult, TranscriptWord } from "../types";
import { ModelSelect } from "./ModelSelect";

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

export function AsrPanel({ models, registeredIds, serverRunning }: Props) {
  const asrModels = models.filter((m) => m.task === "asr" && m.family);
  const [modelId, setModelId] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ uploadId: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [result, setResult] = useState<TranscribeResult | null>(null);
  const [mode, setMode] = useState<"text" | "karaoke">(
    () => (localStorage.getItem("asrMode") === "text" ? "text" : "karaoke"),
  );
  const model = asrModels.find((m) => m.id === modelId);

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

  async function onDrop(files: File[]) {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    try {
      // The ASR pipeline (and its Silero VAD chunker) works at 16 kHz.
      const res = await api.upload(await fileToWavUpload(file, 16000));
      setUpload({ uploadId: res.uploadId, name: res.originalName });
      setResult(null);
    } catch (err) {
      notifications.show({ color: "red", title: "Upload failed", message: (err as Error).message });
    } finally {
      setUploading(false);
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
            <Dropzone onDrop={onDrop} loading={uploading} accept={["audio/*", "video/webm"]} maxFiles={1} multiple={false}>
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
                <Text size="sm">Drop an audio file to transcribe, or click to browse</Text>
              </Group>
            </Dropzone>
            {upload && <Text size="sm" c="teal">Audio: {upload.name}</Text>}
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
          </Paper>
        )}
      </Grid.Col>
    </Grid>
  );
}
