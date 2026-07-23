import { useEffect, useState } from "react";
import { Button, Grid, Paper, Stack, Text, Textarea, Title } from "@mantine/core";
import { IconWaveSine } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type { DiscoveredModel, TtsParams } from "../types";
import { ModelSelect } from "./ModelSelect";
import { VoicePicker, type VoiceValue } from "./VoicePicker";
import { ParamsAccordion } from "./ParamsAccordion";
import { OutputPlayer } from "./OutputPlayer";
import { inspectWav } from "../lib/wav";

interface Props {
  models: DiscoveredModel[];
  registeredIds: string[];
  serverRunning: boolean;
}

// Remember the last saved voice across model switches and app restarts.
const LAST_SAVED_VOICE_KEY = "audiocpp.lastSavedVoiceId";

export function TtsPanel({ models, registeredIds, serverRunning }: Props) {
  const [modelId, setModelId] = useState<string | null>(null);
  const [text, setText] = useState("audio.cpp is running locally on my own GPU.");
  const [voice, setVoice] = useState<VoiceValue>(() => {
    const remembered = localStorage.getItem(LAST_SAVED_VOICE_KEY);
    return remembered ? { mode: "clone", savedVoiceId: remembered } : { mode: "builtin" };
  });
  const [instructions, setInstructions] = useState("");
  const [params, setParams] = useState<TtsParams>({});
  const [generating, setGenerating] = useState(false);
  const [current, setCurrent] = useState<{ url: string; name: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const model = models.find((m) => m.id === modelId);

  useEffect(() => {
    if (!model) return;
    // Keep the saved voice when switching to another clone-capable model, falling
    // back to the one remembered from a previous session; only wipe it otherwise.
    const remembered = model.clone
      ? voice.savedVoiceId ?? localStorage.getItem(LAST_SAVED_VOICE_KEY)
      : null;
    const mode: VoiceValue["mode"] = remembered
      ? "clone"
      : model.builtinVoices.length > 0
        ? "builtin"
        : model.clone
          ? "clone"
          : "builtin";
    setVoice({ mode, voiceId: null, upload: null, savedVoiceId: remembered, referenceText: "" });
    setInstructions("");
    // A language picked for the previous model may not exist on this one.
    setParams((p) => ({ ...p, language: undefined }));
  }, [modelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the last saved voice so it survives model switches and app restarts.
  useEffect(() => {
    if (voice.savedVoiceId) localStorage.setItem(LAST_SAVED_VOICE_KEY, voice.savedVoiceId);
  }, [voice.savedVoiceId]);

  async function generate() {
    if (!model) return;
    if (!serverRunning) {
      notifications.show({ color: "yellow", message: "Start the server first." });
      return;
    }
    if (!registeredIds.includes(model.id)) {
      notifications.show({ color: "yellow", message: "This model isn't registered in the running server." });
      return;
    }
    if (!text.trim()) {
      notifications.show({ color: "yellow", message: "Enter some text to synthesize." });
      return;
    }
    if (voice.mode === "builtin" && model.builtinVoices.length > 0 && !voice.voiceId) {
      notifications.show({ color: "yellow", message: "Select a built-in voice." });
      return;
    }
    if (voice.mode === "clone" && !voice.upload && !voice.savedVoiceId) {
      notifications.show({ color: "yellow", message: "Pick a saved voice or upload a reference clip to clone." });
      return;
    }

    setGenerating(true);
    try {
      const payload = {
        model: model.id,
        text,
        voiceId: voice.mode === "builtin" ? voice.voiceId : undefined,
        savedVoiceId: voice.mode === "clone" ? voice.savedVoiceId || undefined : undefined,
        uploadId: voice.mode === "clone" && !voice.savedVoiceId ? voice.upload?.uploadId : undefined,
        referenceText:
          voice.mode === "clone" && !voice.savedVoiceId ? voice.referenceText || undefined : undefined,
        instructions: model.voiceDesign ? instructions || undefined : undefined,
        params,
      };
      const { blob, name } = await api.tts(payload);
      const { durationSec, peak } = await inspectWav(blob);
      const url = URL.createObjectURL(blob);
      setCurrent((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url, name: name ?? "output.wav" };
      });
      setRefreshKey((k) => k + 1);

      // The model sometimes stops immediately and returns a ~0s / silent clip.
      // Keep the file (it still lands in history) but flag it clearly.
      const silent = peak !== null && peak < 0.01;
      if (durationSec < 0.5 || silent) {
        const detail = silent
          ? `${durationSec.toFixed(1)}s of near-silence`
          : `only ${durationSec.toFixed(2)}s of audio`;
        notifications.show({
          color: "yellow",
          title: "No audio produced",
          message: `The model returned ${detail} — usually a bad sample. Click Generate again, or adjust temperature / seed in Advanced parameters.`,
          autoClose: 8000,
        });
      } else {
        notifications.show({ color: "teal", message: `Generated ${durationSec.toFixed(1)}s of audio.` });
      }
    } catch (err) {
      notifications.show({ color: "red", title: "Generation failed", message: (err as Error).message });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Grid gap="md">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Paper withBorder p="md" radius="md">
          <Stack gap="md">
            <Title order={5}>Text to speech</Title>
            <ModelSelect
              models={models}
              task="tts"
              registeredIds={registeredIds}
              serverRunning={serverRunning}
              value={modelId}
              onChange={setModelId}
            />
            <Textarea
              label="Text"
              autosize
              minRows={4}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
            />
            <VoicePicker model={model} value={voice} onChange={setVoice} />
            {model?.voiceDesign && (
              <Textarea
                label="Voice design instructions (optional)"
                description="Describe the voice in words, e.g. 'a calm elderly narrator with a warm tone'"
                autosize
                minRows={2}
                value={instructions}
                onChange={(e) => setInstructions(e.currentTarget.value)}
              />
            )}
            <ParamsAccordion params={params} onChange={setParams} languages={model?.languages ?? []} />
            <div>
              <Button
                leftSection={<IconWaveSine size={18} />}
                onClick={generate}
                loading={generating}
                disabled={!model || !serverRunning}
                size="md"
              >
                Generate
              </Button>
              {generating && (
                <Text size="xs" c="dimmed" mt="xs">
                  Generating… the first request for a model loads it into VRAM, which can take a little while.
                </Text>
              )}
            </div>
          </Stack>
        </Paper>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        <OutputPlayer current={current} refreshKey={refreshKey} />
      </Grid.Col>
    </Grid>
  );
}
