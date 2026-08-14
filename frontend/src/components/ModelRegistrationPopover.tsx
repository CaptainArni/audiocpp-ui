import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Popover,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconChevronDown, IconSearch, IconStack2 } from "@tabler/icons-react";
import type { DiscoveredModel, Task } from "../types";
import { StatusDot } from "./ui/primitives";

/** The order the groups read in, and what to call them. */
const GROUPS: { task: Task; label: string }[] = [
  { task: "tts", label: "Speech" },
  { task: "asr", label: "Transcription" },
  { task: "gen", label: "Music" },
];

interface Props {
  models: DiscoveredModel[];
  included: string[];
  onChange: (ids: string[]) => void;
  /** Registered in the *running* server — i.e. what is live right now. */
  registered: string[];
  /** Selection can't take effect until the next start. */
  locked: boolean;
  unknownCount: number;
}

/**
 * Which models the next start registers.
 *
 * This used to be a wrapping `Group` of raw checkboxes — ten of them, three
 * ragged rows, permanently parked at the top of the fold for a control that is
 * touched about once per session. Behind a summary button it costs one line and
 * gains grouping, a filter and per-group select-all; everything it warned about
 * before it still warns about.
 */
export function ModelRegistrationPopover({
  models,
  included,
  onChange,
  registered,
  locked,
  unknownCount,
}: Props) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");

  const known = useMemo(() => models.filter((m) => m.family && m.task), [models]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? known.filter((m) => m.id.toLowerCase().includes(q)) : known;
  }, [known, query]);

  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...new Set([...included, id])] : included.filter((x) => x !== id));

  const setGroup = (task: Task, on: boolean) => {
    const ids = filtered.filter((m) => m.task === task).map((m) => m.id);
    onChange(
      on ? [...new Set([...included, ...ids])] : included.filter((x) => !ids.includes(x)),
    );
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={400}
      shadow="xl"
      trapFocus
    >
      <Popover.Target>
        <Button
          variant="default"
          size="compact-sm"
          leftSection={<IconStack2 size={15} />}
          rightSection={<IconChevronDown size={13} />}
          onClick={() => setOpened((o) => !o)}
        >
          {included.length} of {known.length} models
        </Button>
      </Popover.Target>

      <Popover.Dropdown p={0}>
        <Box p="xs" style={{ borderBottom: "1px solid var(--app-border)" }}>
          <TextInput
            size="xs"
            placeholder="Filter models…"
            leftSection={<IconSearch size={14} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <Text size="xs" c="dimmed" mt={6}>
            Registered models load lazily — into VRAM on first use — so you can switch between them
            per request without restarting.
          </Text>
        </Box>

        <Box p="xs" mah={380} style={{ overflowY: "auto" }}>
          <Stack gap="sm">
            {GROUPS.map(({ task, label }) => {
              const rows = filtered.filter((m) => m.task === task);
              if (rows.length === 0) return null;
              const on = rows.filter((m) => included.includes(m.id)).length;
              return (
                <div key={task}>
                  <Group justify="space-between" mb={4}>
                    <span className="app-eyebrow">
                      {label} · {on}/{rows.length}
                    </span>
                    {!locked && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        onClick={() => setGroup(task, on < rows.length)}
                      >
                        {on < rows.length ? "All" : "None"}
                      </Button>
                    )}
                  </Group>
                  <Stack gap={2}>
                    {rows.map((m) => (
                      <Checkbox
                        key={m.id}
                        size="xs"
                        disabled={locked}
                        checked={included.includes(m.id)}
                        onChange={(e) => toggle(m.id, e.currentTarget.checked)}
                        label={
                          <Group gap={6} wrap="nowrap">
                            {/* A live dot means this one is in the server that
                                is running now, not merely ticked for next time. */}
                            {registered.includes(m.id) && <StatusDot tone="ok" />}
                            <Text size="xs" style={{ wordBreak: "break-all" }}>
                              {m.id}
                            </Text>
                            {m.sizeMB ? (
                              <Text size="xs" c="dimmed" className="app-mono" style={{ flex: "none" }}>
                                {(m.sizeMB / 1024).toFixed(1)} GB
                              </Text>
                            ) : null}
                          </Group>
                        }
                      />
                    ))}
                  </Stack>
                </div>
              );
            })}

            {filtered.length === 0 && (
              <Text size="xs" c="dimmed" ta="center" py="md">
                {known.length === 0
                  ? "No usable models found in the models folder."
                  : "Nothing matches that filter."}
              </Text>
            )}
          </Stack>
        </Box>

        {(locked || unknownCount > 0) && (
          <Box p="xs" style={{ borderTop: "1px solid var(--app-border)" }}>
            {locked && (
              <Badge size="xs" variant="light" color="yellow">
                stop the server to change this
              </Badge>
            )}
            {unknownCount > 0 && (
              <Text size="xs" c="dimmed" mt={locked ? 6 : 0}>
                {unknownCount} unrecognized folder{unknownCount === 1 ? "" : "s"} in the models
                directory {unknownCount === 1 ? "was" : "were"} skipped.
              </Text>
            )}
          </Box>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
