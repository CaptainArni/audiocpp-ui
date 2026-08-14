import { useEffect, useState } from "react";
import { ActionIcon, Box, Button, Stack, Text, Tooltip } from "@mantine/core";
import { IconTrash, IconWaveSine } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type { Generation } from "../types";
import { AudioPlayer, DownloadAction } from "./ui/AudioPlayer";
import { EmptyState, SectionCard } from "./ui/primitives";

interface Props {
  current: { url: string; name: string } | null;
  refreshKey: number;
}

/** `tts-1786715161900.wav` reads better as a time than as a serial number. */
function stamp(name: string): string {
  const m = /(\d{13})/.exec(name);
  if (!m) return name;
  return new Date(Number(m[1])).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * How many rows are rendered before "show more".
 *
 * Every row is a media element and a canvas, and this list runs to hundreds on
 * a machine that has been used for a while. Rendering all of them at once is
 * enough DOM and enough decoding to visibly stall the tab.
 */
const PAGE = 40;

export function OutputPlayer({ current, refreshKey }: Props) {
  const [history, setHistory] = useState<Generation[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    api.getGenerations().then(setHistory).catch(() => setHistory([]));
  }, [refreshKey]);

  async function clearAll() {
    if (!window.confirm(`Delete all ${history.length} saved generations? This cannot be undone.`))
      return;
    setClearing(true);
    try {
      const { removed } = await api.clearGenerations();
      setHistory([]);
      notifications.show({
        color: "gray",
        message: `Cleared ${removed} generation${removed === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      notifications.show({ color: "red", title: "Clear failed", message: (err as Error).message });
    } finally {
      setClearing(false);
    }
  }

  return (
    <Stack gap="sm">
      {current && (
        <SectionCard title="Latest generation" icon={<IconWaveSine size={14} />}>
          {/* key forces a fresh player (and fresh peaks) for the new blob */}
          <AudioPlayer
            key={current.url}
            src={current.url}
            variant="full"
            actions={<DownloadAction href={current.url} name={current.name} />}
          />
          <Text size="xs" c="dimmed" mt={8} truncate className="app-mono">
            {current.name}
          </Text>
        </SectionCard>
      )}

      <SectionCard
        title={`History${history.length ? ` · ${history.length}` : ""}`}
        actions={
          history.length > 0 && (
            <Tooltip label="Delete all saved generations">
              <ActionIcon
                variant="subtle"
                color="red"
                size="sm"
                onClick={clearAll}
                loading={clearing}
                aria-label="Clear all generations"
              >
                <IconTrash size={15} />
              </ActionIcon>
            </Tooltip>
          )
        }
        flush
      >
        {history.length === 0 ? (
          <Box p="md">
            <EmptyState
              title="Nothing generated yet"
              hint="Every clip you render is kept here until you clear it."
            />
          </Box>
        ) : (
          <Box p={6} mah={620} style={{ overflowY: "auto", overflowX: "hidden" }}>
            {history.slice(0, shown).map((g) => (
              <div key={g.name} className="app-track">
                <div className="app-track-head">
                  <span className="app-track-name">{stamp(g.name)}</span>
                  <Text size="xs" c="dimmed" className="app-mono" style={{ flex: "none" }}>
                    {g.sizeKB} KB
                  </Text>
                </div>
                <AudioPlayer
                  src={g.url}
                  sizeBytes={g.sizeKB * 1024}
                  actions={<DownloadAction href={g.url} name={g.name} />}
                />
              </div>
            ))}
            {history.length > shown && (
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                fullWidth
                mt={4}
                onClick={() => setShown((n) => n + PAGE)}
              >
                Show {Math.min(PAGE, history.length - shown)} more · {history.length - shown} left
              </Button>
            )}
          </Box>
        )}
      </SectionCard>
    </Stack>
  );
}
