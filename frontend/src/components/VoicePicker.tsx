import { useEffect, useMemo, useState } from "react";
import { Alert, SegmentedControl, Select, Stack } from "@mantine/core";
import { IconInfoCircle, IconMicrophone, IconUser } from "@tabler/icons-react";
import { api } from "../api";
import type { DiscoveredModel, SavedVoice } from "../types";

/**
 * Which voice to speak with.
 *
 * `clone` means "a voice saved in the Saved Voices tab". Creating one from a
 * clip is *not* part of this picker: it lives in that tab, along with previewing
 * and deleting. Everywhere else a voice is only ever chosen, never managed —
 * five panels each offering upload/record/delete was five copies of one job, and
 * put a destructive button next to a dropdown people use constantly.
 */
export interface VoiceValue {
  mode: "builtin" | "clone";
  voiceId?: string | null;
  savedVoiceId?: string | null;
}

interface Props {
  model: DiscoveredModel | undefined;
  value: VoiceValue;
  onChange: (v: VoiceValue) => void;
}

export function VoicePicker({ model, value, onChange }: Props) {
  const [voices, setVoices] = useState<SavedVoice[]>([]);

  useEffect(() => {
    api.getVoices().then(setVoices).catch(() => {});
  }, []);

  const modes = useMemo(() => {
    const list: { label: string; value: string }[] = [];
    if (model && model.builtinVoices.length > 0) list.push({ label: "Built-in voice", value: "builtin" });
    if (model?.clone) list.push({ label: "Saved voice", value: "clone" });
    return list;
  }, [model]);

  // Snap to a mode this model actually offers. A clone-only model (Higgs has no
  // built-in voices) left on "builtin" renders an empty voice dropdown with the
  // mode switch showing no selection — a dead end the user cannot click out of.
  const modeValues = modes.map((m) => m.value).join("|");
  useEffect(() => {
    if (modes.length === 0) return;
    if (!modes.some((m) => m.value === value.mode)) {
      onChange({ ...value, mode: modes[0].value as VoiceValue["mode"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeValues, value.mode]);

  if (!model) return null;

  if (modes.length === 0) {
    return (
      <Alert color="gray" variant="light">
        This model has no built-in voices and does not expose cloning; it will use its default voice.
      </Alert>
    );
  }

  return (
    <Stack gap="xs">
      {/* One mode is not a choice — don't render a switch with a single option. */}
      {modes.length > 1 && (
        <SegmentedControl
          data={modes}
          value={value.mode}
          onChange={(mode) => onChange({ ...value, mode: mode as VoiceValue["mode"] })}
        />
      )}

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

      {value.mode === "clone" &&
        (voices.length === 0 ? (
          <Alert icon={<IconInfoCircle size={18} />} color="gray" variant="light">
            No saved voices yet — record or upload one in the <b>Saved Voices</b> tab, then pick it here.
          </Alert>
        ) : (
          <Select
            label="Saved voice"
            placeholder="Select a saved voice"
            searchable
            data={voices.map((v) => ({
              value: v.id,
              label: v.durationSec != null ? `${v.name} · ${v.durationSec.toFixed(1)}s` : v.name,
            }))}
            value={value.savedVoiceId ?? null}
            onChange={(id) => onChange({ ...value, savedVoiceId: id })}
            leftSection={<IconUser size={16} />}
          />
        ))}
    </Stack>
  );
}
