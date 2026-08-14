import { useEffect } from "react";
import { Select, Group, Badge, Text, Stack } from "@mantine/core";
import type { DiscoveredModel, Task } from "../types";

interface Props {
  models: DiscoveredModel[];
  task: Task;
  registeredIds: string[];
  serverRunning: boolean;
  value: string | null;
  onChange: (id: string | null) => void;
  /**
   * Where to remember the last choice. Defaults to one slot per task, shared by
   * every panel. The Call tab passes its own, because a call wants a fast
   * streaming model while a reading may well want the slow high-quality one —
   * sharing the slot means picking one silently re-picks the other.
   */
  storageKey?: string;
  /** Hide models that can't stream, for callers that require it. */
  streamingOnly?: boolean;
}

export function ModelSelect({
  models,
  task,
  registeredIds,
  serverRunning,
  value,
  onChange,
  storageKey,
  streamingOnly,
}: Props) {
  const memoryKey = storageKey ?? `lastModel.${task}`;
  const candidates = models.filter(
    (m) => m.task === task && m.family && (!streamingOnly || m.streaming),
  );
  const data = candidates.map((m) => ({
    value: m.id,
    label: `${m.id}  ·  ${m.family}${m.sizeMB ? `  ·  ${(m.sizeMB / 1024).toFixed(1)} GB` : ""}`,
  }));

  const selected = candidates.find((m) => m.id === value) ?? null;
  const notRegistered = serverRunning && value != null && !registeredIds.includes(value);

  // Auto-select: prefer the last used model (per task), else a sole candidate.
  const candidateIds = candidates.map((m) => m.id).join("|");
  useEffect(() => {
    if (value != null || candidates.length === 0) return;
    const stored = localStorage.getItem(memoryKey);
    if (stored && candidates.some((m) => m.id === stored)) {
      onChange(stored);
    } else if (candidates.length === 1) {
      onChange(candidates[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, candidateIds, task, memoryKey]);

  const handleChange = (id: string | null) => {
    if (id) localStorage.setItem(memoryKey, id);
    onChange(id);
  };

  return (
    <Stack gap={4}>
      <Select
        label={`${task.toUpperCase()} model`}
        placeholder={candidates.length ? "Select a model" : "No matching models downloaded"}
        data={data}
        value={value}
        onChange={handleChange}
        disabled={candidates.length === 0}
        searchable
        nothingFoundMessage="No models"
      />
      {selected && (
        <Group gap={6}>
          {selected.builtinVoices.length > 0 && (
            <Badge size="sm" variant="light" color="violet">
              {selected.builtinVoices.length} built-in voices
            </Badge>
          )}
          {selected.clone && (
            <Badge size="sm" variant="light" color="teal">
              voice cloning
            </Badge>
          )}
          {selected.voiceDesign && (
            <Badge size="sm" variant="light" color="orange">
              voice design
            </Badge>
          )}
          {serverRunning &&
            (registeredIds.includes(selected.id) ? (
              <Badge size="sm" variant="dot" color="teal">
                registered
              </Badge>
            ) : (
              <Badge size="sm" variant="dot" color="yellow">
                not registered
              </Badge>
            ))}
        </Group>
      )}
      {notRegistered && (
        <Text size="xs" c="yellow">
          This model isn't registered in the running server. Include it in the server control panel and restart.
        </Text>
      )}
    </Stack>
  );
}
