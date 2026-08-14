import { useEffect, useState } from "react";
import { ActionIcon, Alert, Button, Group, Text, Tooltip } from "@mantine/core";
import { IconPlayerPlay, IconPlayerStop, IconRefresh } from "@tabler/icons-react";
import type { DiscoveredModel, ServerStatus } from "../types";
import { ModelRegistrationPopover } from "./ModelRegistrationPopover";
import "./ui/ui.css";

interface Props {
  status: ServerStatus | null;
  models: DiscoveredModel[];
  onStart: (ids: string[]) => Promise<void>;
  onStop: () => Promise<void>;
  onRescan: () => void;
  busy: boolean;
}

/**
 * The cockpit strip: what the next start will register, and the three buttons
 * that act on the process.
 *
 * It deliberately no longer repeats the run state, host, port, device or pid —
 * those live in the top bar now, where they are visible from every tab. This
 * card used to carry a second copy of all of it plus a wall of checkboxes, and
 * between them they owned the top of the fold on every screen in the app.
 */
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
  // the selection above is for the NEXT start, so call this out.
  const notInRunningServer = running
    ? known.filter((m) => !(status?.includedModelIds ?? []).includes(m.id)).map((m) => m.id)
    : [];

  return (
    <div className="app-card" style={{ padding: "10px 12px" }}>
      <Group justify="space-between" gap="sm" wrap="wrap">
        <Group gap="sm" wrap="wrap" style={{ minWidth: 0 }}>
          <ModelRegistrationPopover
            models={models}
            included={included}
            onChange={setIncluded}
            registered={status?.includedModelIds ?? []}
            locked={running || starting}
            unknownCount={unknownCount}
          />
          {notInRunningServer.length > 0 && (
            <Text size="xs" c="yellow.4">
              {notInRunningServer.length} model{notInRunningServer.length === 1 ? "" : "s"} not in
              the running server — Stop, then Start to include{" "}
              {notInRunningServer.length === 1 ? "it" : "them"}.
            </Text>
          )}
        </Group>

        <Group gap="xs">
          <Tooltip label="Rescan models folder">
            <ActionIcon variant="default" onClick={onRescan} disabled={busy} aria-label="Rescan">
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
          <Button
            size="compact-sm"
            leftSection={<IconPlayerPlay size={15} />}
            onClick={() => onStart(included)}
            loading={starting || busy}
            disabled={!canStart}
          >
            Start
          </Button>
          <Button
            size="compact-sm"
            color="red"
            variant="light"
            leftSection={<IconPlayerStop size={15} />}
            onClick={onStop}
            disabled={state === "stopped"}
            loading={busy && state !== "stopped"}
          >
            Stop
          </Button>
        </Group>
      </Group>

      {status?.lastError && state === "error" && (
        <Alert color="red" mt="xs" p="xs">
          <Text size="xs">{status.lastError}</Text>
        </Alert>
      )}
    </div>
  );
}
