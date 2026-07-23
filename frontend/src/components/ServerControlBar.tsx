import { useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
} from "@tabler/icons-react";
import type { DiscoveredModel, ServerRunState, ServerStatus } from "../types";

const STATE_COLOR: Record<ServerRunState, string> = {
  stopped: "gray",
  starting: "yellow",
  running: "green",
  error: "red",
};

interface Props {
  status: ServerStatus | null;
  models: DiscoveredModel[];
  onStart: (ids: string[]) => Promise<void>;
  onStop: () => Promise<void>;
  onRescan: () => void;
  busy: boolean;
}

export function ServerControlBar({ status, models, onStart, onStop, onRescan, busy }: Props) {
  const known = models.filter((m) => m.family && m.task);
  const unknownCount = models.length - known.length;
  const [included, setIncluded] = useState<string[]>([]);

  useEffect(() => {
    setIncluded((prev) => {
      const valid = known.map((m) => m.id);
      const kept = prev.filter((id) => valid.includes(id));
      return kept.length ? kept : valid; // default: all known
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  const state = status?.state ?? "stopped";
  const running = state === "running";
  const starting = state === "starting";
  const canStart = !running && !starting && included.length > 0;

  // Models discovered on disk but not part of the currently running server —
  // the checkboxes show the selection for the NEXT start, so call this out.
  const notInRunningServer = running
    ? known.filter((m) => !(status?.includedModelIds ?? []).includes(m.id)).map((m) => m.id)
    : [];

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <Group gap="sm">
            <Text fw={600}>Server</Text>
            <Badge color={STATE_COLOR[state]} variant={running ? "filled" : "light"} size="lg">
              {state}
            </Badge>
            {status && (running || starting) && (
              <Text size="sm" c="dimmed">
                {status.host}:{status.port} · device {status.device}
                {status.pid ? ` · pid ${status.pid}` : ""}
                {running ? ` · ${status.healthModels} loaded slot(s)` : ""}
              </Text>
            )}
          </Group>
          <Group gap="xs">
            <Tooltip label="Rescan models folder">
              <ActionIcon variant="default" onClick={onRescan} disabled={busy} size="lg">
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
            <Button
              leftSection={<IconPlayerPlay size={16} />}
              onClick={() => onStart(included)}
              loading={starting || busy}
              disabled={!canStart}
            >
              Start
            </Button>
            <Button
              color="red"
              variant="light"
              leftSection={<IconPlayerStop size={16} />}
              onClick={onStop}
              disabled={state === "stopped"}
              loading={busy && state !== "stopped"}
            >
              Stop
            </Button>
          </Group>
        </Group>

        {status?.lastError && state === "error" && (
          <Text size="sm" c="red">
            {status.lastError}
          </Text>
        )}

        <Checkbox.Group
          label="Models to register on start"
          description="All registered models load lazily (into VRAM on first use). You can switch between them per request without restarting."
          value={included}
          onChange={setIncluded}
        >
          <Group gap="md" mt="xs">
            {known.map((m) => (
              <Checkbox
                key={m.id}
                value={m.id}
                disabled={running || starting}
                label={`${m.id} (${m.task})`}
              />
            ))}
            {known.length === 0 && (
              <Text size="sm" c="dimmed">
                No usable models found in the models folder.
              </Text>
            )}
          </Group>
        </Checkbox.Group>
        {notInRunningServer.length > 0 && (
          <Text size="xs" c="yellow">
            Not registered in the running server: {notInRunningServer.join(", ")} — press Stop, then Start to
            include {notInRunningServer.length === 1 ? "it" : "them"}.
          </Text>
        )}
        {unknownCount > 0 && (
          <Text size="xs" c="dimmed">
            {unknownCount} unrecognized folder(s) in the models directory were skipped.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
