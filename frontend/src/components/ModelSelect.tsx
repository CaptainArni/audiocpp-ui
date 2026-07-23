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
}

export function ModelSelect({ models, task, registeredIds, serverRunning, value, onChange }: Props) {
  const candidates = models.filter((m) => m.task === task && m.family);
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
    const stored = localStorage.getItem(`lastModel.${task}`);
    if (stored && candidates.some((m) => m.id === stored)) {
      onChange(stored);
    } else if (candidates.length === 1) {
      onChange(candidates[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, candidateIds, task]);

  const handleChange = (id: string | null) => {
    if (id) localStorage.setItem(`lastModel.${task}`, id);
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
        <Group gap="xs">
          {selected.builtinVoices.length > 0 && (
            <Badge variant="light" color="grape">
              {selected.builtinVoices.length} built-in voices
            </Badge>
          )}
          {selected.clone && (
            <Badge variant="light" color="teal">
              voice cloning
            </Badge>
          )}
          {selected.voiceDesign && (
            <Badge variant="light" color="orange">
              voice design
            </Badge>
          )}
          {serverRunning &&
            (registeredIds.includes(selected.id) ? (
              <Badge variant="dot" color="green">
                registered
              </Badge>
            ) : (
              <Badge variant="dot" color="yellow">
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
