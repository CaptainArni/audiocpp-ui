import { useEffect, useState } from "react";
import { ActionIcon, Anchor, Card, Divider, Group, ScrollArea, Stack, Text, Title, Tooltip } from "@mantine/core";
import { IconDownload, IconTrash } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type { Generation } from "../types";

interface Props {
  current: { url: string; name: string } | null;
  refreshKey: number;
}

export function OutputPlayer({ current, refreshKey }: Props) {
  const [history, setHistory] = useState<Generation[]>([]);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    api.getGenerations().then(setHistory).catch(() => setHistory([]));
  }, [refreshKey]);

  async function clearAll() {
    if (!window.confirm(`Delete all ${history.length} saved generations? This cannot be undone.`)) return;
    setClearing(true);
    try {
      const { removed } = await api.clearGenerations();
      setHistory([]);
      notifications.show({ color: "gray", message: `Cleared ${removed} generation${removed === 1 ? "" : "s"}.` });
    } catch (err) {
      notifications.show({ color: "red", title: "Clear failed", message: (err as Error).message });
    } finally {
      setClearing(false);
    }
  }

  return (
    <Stack gap="sm">
      {current && (
        <Card withBorder radius="md" padding="sm">
          <Group justify="space-between" mb="xs">
            <Text fw={600}>Latest generation</Text>
            <Anchor href={current.url} download={current.name} size="sm">
              <Group gap={4}>
                <IconDownload size={16} /> download
              </Group>
            </Anchor>
          </Group>
          {/* key forces the audio element to reload the new blob */}
          <audio key={current.url} controls src={current.url} style={{ width: "100%" }} />
        </Card>
      )}

      {history.length > 0 && (
        <Card withBorder radius="md" padding="sm">
          <Group justify="space-between" mb="xs">
            <Title order={6}>History</Title>
            <Tooltip label="Delete all saved generations" withArrow>
              <ActionIcon
                variant="subtle"
                color="red"
                size="sm"
                onClick={clearAll}
                loading={clearing}
                aria-label="Clear all generations"
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <ScrollArea.Autosize mah={560} offsetScrollbars type="auto">
            <Stack gap="xs">
              {history.map((g, i) => (
                <div key={g.name}>
                  {i > 0 && <Divider mb="xs" />}
                  <Group justify="space-between" gap="sm" wrap="nowrap">
                    <Text size="xs" c="dimmed" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.name} · {g.sizeKB} KB
                    </Text>
                    <Anchor href={g.url} download={g.name} size="xs">
                      <IconDownload size={14} />
                    </Anchor>
                  </Group>
                  <audio controls preload="none" src={g.url} style={{ width: "100%", height: 32 }} />
                </div>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </Card>
      )}
    </Stack>
  );
}
