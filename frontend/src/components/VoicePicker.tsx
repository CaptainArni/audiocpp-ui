import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
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
  IconUser,
  IconX,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import { fileToWavUpload } from "../lib/wav";
import { sampleTexts } from "../lib/sampleTexts";
import { MicRecorder } from "./MicRecorder";
import type { DiscoveredModel, SavedVoice } from "../types";

export interface VoiceValue {
  mode: "builtin" | "clone";
  voiceId?: string | null;
  upload?: { uploadId: string; name: string } | null;
  savedVoiceId?: string | null;
  referenceText?: string;
}

interface Props {
  model: DiscoveredModel | undefined;
  value: VoiceValue;
  onChange: (v: VoiceValue) => void;
}

type CloneSource = "saved" | "upload" | "record";

export function VoicePicker({ model, value, onChange }: Props) {
  const [uploading, setUploading] = useState(false);
  const [cloneSource, setCloneSource] = useState<CloneSource>("upload");
  const [voices, setVoices] = useState<SavedVoice[]>([]);
  const [voiceName, setVoiceName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getVoices()
      .then((vs) => {
        setVoices(vs);
        if (vs.length > 0) setCloneSource("saved");
      })
      .catch(() => {});
  }, []);

  // Surface the saved-voice dropdown when one is restored externally (e.g. a
  // remembered voice preserved across a model switch).
  useEffect(() => {
    if (value.mode === "clone" && value.savedVoiceId) setCloneSource("saved");
  }, [value.savedVoiceId, value.mode]);

  const modes = useMemo(() => {
    const list: { label: string; value: string }[] = [];
    if (model && model.builtinVoices.length > 0) list.push({ label: "Built-in voice", value: "builtin" });
    if (model?.clone) list.push({ label: "Clone from clip", value: "clone" });
    return list;
  }, [model]);

  if (!model) return null;

  if (modes.length === 0) {
    return (
      <Alert color="gray" variant="light">
        This model has no built-in voices and does not expose cloning; it will use its default voice.
      </Alert>
    );
  }

  const savedVoice = voices.find((v) => v.id === value.savedVoiceId) ?? null;

  async function onDrop(files: File[]) {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.upload(await fileToWavUpload(file));
      onChange({
        ...value,
        mode: "clone",
        upload: { uploadId: res.uploadId, name: res.originalName },
        savedVoiceId: null,
      });
      notifications.show({ color: "teal", message: `Reference clip uploaded: ${res.originalName}` });
    } catch (err) {
      notifications.show({ color: "red", title: "Upload failed", message: (err as Error).message });
    } finally {
      setUploading(false);
    }
  }

  async function saveVoice() {
    if (!value.upload) return;
    const name = voiceName.trim();
    if (!name) {
      notifications.show({ color: "yellow", message: "Give the voice a name first." });
      return;
    }
    setSaving(true);
    try {
      const res = await api.saveVoice({
        uploadId: value.upload.uploadId,
        name,
        referenceText: value.referenceText || undefined,
      });
      const vs = await api.getVoices();
      setVoices(vs);
      setVoiceName("");
      setCloneSource("saved");
      onChange({ ...value, mode: "clone", savedVoiceId: res.id, upload: null });
      notifications.show({ color: "teal", message: `Voice "${name}" saved.` });
    } catch (err) {
      notifications.show({ color: "red", title: "Saving voice failed", message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function deleteVoice(id: string) {
    try {
      await api.deleteVoice(id);
      setVoices((vs) => vs.filter((v) => v.id !== id));
      if (value.savedVoiceId === id) onChange({ ...value, savedVoiceId: null });
    } catch (err) {
      notifications.show({ color: "red", title: "Delete failed", message: (err as Error).message });
    }
  }

  return (
    <Stack gap="sm">
      <SegmentedControl
        data={modes}
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode: mode as VoiceValue["mode"] })}
      />

      {value.mode === "builtin" && (
        <Select
          label="Voice"
          placeholder="Select a built-in voice"
          searchable
          data={model.builtinVoices}
          value={value.voiceId ?? null}
          onChange={(v) => onChange({ ...value, voiceId: v })}
          leftSection={<IconMicrophone size={16} />}
        />
      )}

      {value.mode === "clone" && (
        <Stack gap="xs">
          <SegmentedControl
            size="xs"
            data={[
              { label: `Saved voices (${voices.length})`, value: "saved" },
              { label: "Upload clip", value: "upload" },
              { label: "Record mic", value: "record" },
            ]}
            value={cloneSource}
            onChange={(v) => {
              const source = v as CloneSource;
              setCloneSource(source);
              // Saved voice and ad-hoc clip are mutually exclusive references.
              if (source === "saved") {
                // Refresh in case voices were added/removed in the Saved Voices tab.
                api.getVoices().then(setVoices).catch(() => {});
                onChange({ ...value, upload: null });
              } else {
                onChange({ ...value, savedVoiceId: null });
              }
            }}
          />

          {cloneSource === "saved" && (
            <Stack gap="xs">
              {voices.length === 0 ? (
                <Alert color="gray" variant="light">
                  No saved voices yet. Upload or record a clip, add its transcript, and click "Save voice" to reuse
                  it here.
                </Alert>
              ) : (
                <Group align="end" gap="xs" wrap="nowrap">
                  <Select
                    style={{ flex: 1 }}
                    label="Saved voice"
                    placeholder="Select a saved voice"
                    searchable
                    leftSection={<IconUser size={16} />}
                    data={voices.map((v) => ({
                      value: v.id,
                      label: v.durationSec ? `${v.name} · ${v.durationSec.toFixed(1)}s` : v.name,
                    }))}
                    value={value.savedVoiceId ?? null}
                    onChange={(v) => onChange({ ...value, savedVoiceId: v, upload: null })}
                    onDropdownOpen={() => api.getVoices().then(setVoices).catch(() => {})}
                  />
                  {savedVoice && (
                    <Tooltip label={`Delete "${savedVoice.name}"`}>
                      <ActionIcon variant="light" color="red" size="lg" mb={1} onClick={() => deleteVoice(savedVoice.id)}>
                        <IconTrash size={18} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              )}
              {savedVoice && (
                <>
                  <audio controls src={api.voiceAudioUrl(savedVoice.id)} style={{ width: "100%", height: 36 }} />
                  {savedVoice.referenceText && (
                    <Text size="xs" c="dimmed" lineClamp={3}>
                      Transcript: {savedVoice.referenceText}
                    </Text>
                  )}
                </>
              )}
            </Stack>
          )}

          {cloneSource === "upload" && (
            <Dropzone
              onDrop={onDrop}
              loading={uploading}
              accept={["audio/*", "video/webm"]}
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
                <div>
                  <Text size="sm">Drop a reference clip here, or click to browse</Text>
                  <Text size="xs" c="dimmed">
                    A few seconds of clean speech works best — WAV, MP3, WebM, OGG, M4A, FLAC (converted to WAV in the browser)
                  </Text>
                </div>
              </Group>
            </Dropzone>
          )}

          {cloneSource === "record" && (
            <Stack gap="xs">
              <Select
                label="Sample passage"
                description="Pick a passage to read aloud — it fills the reference transcript below"
                placeholder="Choose a passage (optional)"
                clearable
                data={sampleTexts.map((s) => ({ value: s.label, label: s.label }))}
                value={sampleTexts.find((s) => s.text === value.referenceText)?.label ?? null}
                onChange={(label) => {
                  const s = sampleTexts.find((x) => x.label === label);
                  onChange({ ...value, referenceText: s ? s.text : "" });
                }}
              />
              <MicRecorder
                prompt={value.referenceText}
                onUploaded={(upload) => onChange({ ...value, mode: "clone", upload, savedVoiceId: null })}
              />
            </Stack>
          )}

          {cloneSource !== "saved" && (
            <>
              {value.upload && (
                <Text size="sm" c="teal">
                  Using reference: {value.upload.name}
                </Text>
              )}
              <Textarea
                label="Reference transcript (optional)"
                description="What the reference clip says — some models clone better with this"
                autosize
                minRows={1}
                value={value.referenceText ?? ""}
                onChange={(e) => onChange({ ...value, referenceText: e.currentTarget.value })}
              />
              {value.upload && (
                <Group align="end" gap="xs">
                  <TextInput
                    style={{ flex: 1 }}
                    label="Save this voice for reuse"
                    placeholder="Voice name, e.g. Arnold (german)"
                    value={voiceName}
                    onChange={(e) => setVoiceName(e.currentTarget.value)}
                  />
                  <Button
                    variant="light"
                    leftSection={<IconDeviceFloppy size={16} />}
                    onClick={saveVoice}
                    loading={saving}
                  >
                    Save voice
                  </Button>
                </Group>
              )}
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}
