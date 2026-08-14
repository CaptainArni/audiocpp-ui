import { useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import {
  IconDeviceFloppy,
  IconFileMusic,
  IconMicrophone,
  IconTrash,
  IconUpload,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import { fileToWavUpload } from "../lib/wav";
import { sampleTexts } from "../lib/sampleTexts";
import { MicRecorder } from "./MicRecorder";
import { AudioPlayer } from "./ui/AudioPlayer";
import { EmptyState, SectionCard } from "./ui/primitives";
import type { SavedVoice } from "../types";

export function VoicesPanel() {
  const [voices, setVoices] = useState<SavedVoice[]>([]);
  const [source, setSource] = useState<"upload" | "record">("upload");
  const [upload, setUpload] = useState<{ uploadId: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [transcript, setTranscript] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = () => api.getVoices().then(setVoices).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  async function onDrop(files: File[]) {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.upload(await fileToWavUpload(file));
      setUpload({ uploadId: res.uploadId, name: res.originalName });
    } catch (err) {
      notifications.show({ color: "red", title: "Upload failed", message: (err as Error).message });
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!upload) {
      notifications.show({ color: "yellow", message: "Upload or record a reference clip first." });
      return;
    }
    if (!name.trim()) {
      notifications.show({ color: "yellow", message: "Give the voice a name." });
      return;
    }
    setSaving(true);
    try {
      await api.saveVoice({ uploadId: upload.uploadId, name: name.trim(), referenceText: transcript || undefined });
      notifications.show({ color: "teal", message: `Voice "${name.trim()}" saved.` });
      setUpload(null);
      setName("");
      setTranscript("");
      refresh();
    } catch (err) {
      notifications.show({ color: "red", title: "Saving voice failed", message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function remove(voice: SavedVoice) {
    if (!window.confirm(`Delete voice "${voice.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteVoice(voice.id);
      setVoices((vs) => vs.filter((v) => v.id !== voice.id));
      notifications.show({ color: "gray", message: `Voice "${voice.name}" deleted.` });
    } catch (err) {
      notifications.show({ color: "red", title: "Delete failed", message: (err as Error).message });
    }
  }

  return (
    <Grid gap="md">
      <Grid.Col span={{ base: 12, md: 5 }}>
        <SectionCard title="New voice" icon={<IconMicrophone size={14} />}>
          <Stack gap="md">
            <SegmentedControl
              size="xs"
              data={[
                { label: "Upload clip", value: "upload" },
                { label: "Record mic", value: "record" },
              ]}
              value={source}
              onChange={(v) => setSource(v as "upload" | "record")}
            />

            {source === "upload" && (
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
                  <div>
                    <Text size="sm">Drop a reference clip here, or click to browse</Text>
                    <Text size="xs" c="dimmed">
                      A few seconds of clean speech works best — WAV, MP3, WebM, OGG, M4A, FLAC
                    </Text>
                  </div>
                </Group>
              </Dropzone>
            )}

            {source === "record" && (
              <Stack gap="xs">
                <Select
                  label="Sample passage"
                  description="Pick a passage to read aloud — it fills the transcript below"
                  placeholder="Choose a passage (optional)"
                  clearable
                  data={sampleTexts.map((s) => ({ value: s.label, label: s.label }))}
                  value={sampleTexts.find((s) => s.text === transcript)?.label ?? null}
                  onChange={(label) => setTranscript(sampleTexts.find((x) => x.label === label)?.text ?? "")}
                />
                <MicRecorder prompt={transcript} onUploaded={setUpload} />
              </Stack>
            )}

            {upload && (
              <Text size="sm" c="teal">
                Using clip: {upload.name}
              </Text>
            )}

            <TextInput
              label="Name"
              placeholder="e.g. Arnold (german)"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Textarea
              label="Transcript (optional)"
              description="What the clip says — models like Qwen3-TTS clone noticeably better with this"
              autosize
              minRows={2}
              value={transcript}
              onChange={(e) => setTranscript(e.currentTarget.value)}
            />
            <div>
              <Button leftSection={<IconDeviceFloppy size={18} />} onClick={save} loading={saving} disabled={!upload}>
                Save voice
              </Button>
            </div>
          </Stack>
        </SectionCard>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 7 }}>
        <SectionCard title={`Saved voices · ${voices.length}`} icon={<IconUsers size={14} />}>
          <Stack gap="sm">
            {voices.length === 0 ? (
              <EmptyState
                icon={<IconUsers size={26} />}
                title="No saved voices yet"
                hint="Create one on the left. This is the only place voices are created, previewed and deleted — every other tab just picks from this list."
              />
            ) : (
              <ScrollArea.Autosize mah={640} offsetScrollbars type="auto">
                <Stack gap="sm">
                  {voices.map((v) => (
                    <Card key={v.id} withBorder radius="md" padding="sm">
                      <Group justify="space-between" mb={4} wrap="nowrap">
                        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                          <Text fw={600} truncate>
                            {v.name}
                          </Text>
                          {v.durationSec != null && (
                            <Badge variant="light" color="gray" size="sm">
                              {v.durationSec.toFixed(1)}s
                            </Badge>
                          )}
                        </Group>
                        <Group gap="xs" wrap="nowrap">
                          <Text size="xs" c="dimmed">
                            {new Date(v.createdAt).toLocaleDateString()}
                          </Text>
                          <Tooltip label="Delete voice">
                            <ActionIcon variant="subtle" color="red" size="sm" onClick={() => remove(v)}>
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Group>
                      <AudioPlayer
                        src={api.voiceAudioUrl(v.id)}
                        sizeBytes={v.sizeKB * 1024}
                        durationSec={v.durationSec}
                      />
                      {v.referenceText && (
                        <Text size="xs" c="dimmed" mt={4} lineClamp={2}>
                          {v.referenceText}
                        </Text>
                      )}
                    </Card>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            )}
          </Stack>
        </SectionCard>
      </Grid.Col>
    </Grid>
  );
}
