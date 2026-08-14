import { useEffect, useState } from "react";
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Collapse,
  Divider,
  Group,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowsShuffle,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconDownload,
  IconMusic,
  IconRepeat,
  IconTrash,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type { MusicTake } from "../types";
import { AudioPlayer } from "./ui/AudioPlayer";
import { EmptyState, SectionCard } from "./ui/primitives";

interface Props {
  /** Takes from the run in progress, shown before the list has been refetched. */
  highlight: MusicTake[];
  refreshKey: number;
  onReuse: (take: MusicTake, mode: "reproduce" | "vary") => void;
}

function duration(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function seconds(ms: number | undefined): string | null {
  if (!ms) return null;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** How much faster than realtime the render was — the honest measure of a
 *  music model, and the number that decides whether four takes are worth it. */
function realtime(take: MusicTake): string | null {
  const wall = (take.timing?.wall_ms ?? 0) / 1000;
  if (!wall || !take.durationSec) return null;
  return `${Math.round(take.durationSec / wall)}× realtime`;
}

/** The variant half of a registered id (`Ace-Step1.5@turbo` → `turbo`). */
function variant(modelId: string): string {
  const at = modelId.lastIndexOf("@");
  return at === -1 ? modelId : modelId.slice(at + 1);
}

/**
 * A take as plain text, for pasting somewhere that is not this app.
 *
 * Deliberately readable rather than the raw request JSON: the JSON already
 * exists in the sidecar next to the WAV, and what a person wants in a message or
 * a notes file is the recipe — seed, model, settings, and the words.
 */
function asText(take: MusicTake): string {
  const s = take.spec;
  const meta = [
    ["model", take.model],
    ["seed", String(take.seed)],
    ["duration", take.durationSec ? `${Math.round(take.durationSec)}s` : null],
    ["steps", s.steps ? String(s.steps) : null],
    ["guidance", s.guidanceScale != null ? String(s.guidanceScale) : null],
    ["bpm", s.bpm ? String(s.bpm) : null],
    ["key", s.keyscale || null],
    ["time signature", s.timeSignature || null],
    ["language", s.language || null],
    ["route", s.route && s.route !== "text2music" ? s.route : null],
    ["rendered in", seconds(take.timing?.wall_ms)],
  ].filter(([, v]) => v) as [string, string][];

  const parts = [
    take.title || "Untitled",
    ...meta.map(([k, v]) => `${k}: ${v}`),
    "",
    "caption:",
    s.caption,
  ];
  if (s.lyrics?.trim()) parts.push("", "lyrics:", s.lyrics.trim());
  if (s.negativePrompt) parts.push("", `negative prompt: ${s.negativePrompt}`);
  return parts.join("\n");
}

export function MusicTakes({ highlight, refreshKey, onReuse }: Props) {
  const [takes, setTakes] = useState<MusicTake[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.getMusicTakes().then(setTakes).catch(() => setTakes([]));
  }, [refreshKey]);

  // A take that has just been rendered is already in `highlight`; the refetch
  // that follows will carry it too, so drop the duplicate rather than show it
  // twice for the second between the two.
  const seen = new Set(takes.map((t) => t.id));
  const rows = [...highlight.filter((t) => !seen.has(t.id)), ...takes];
  const totalMB = Math.round(rows.reduce((n, t) => n + t.sizeBytes, 0) / 1024 / 1024);

  async function remove(take: MusicTake) {
    if (!window.confirm(`Delete this take (seed ${take.seed})? This cannot be undone.`)) return;
    try {
      await api.deleteMusicTake(take.id);
      setTakes((list) => list.filter((t) => t.id !== take.id));
    } catch (err) {
      notifications.show({ color: "red", title: "Delete failed", message: (err as Error).message });
    }
  }

  function copy(take: MusicTake) {
    void navigator.clipboard
      ?.writeText(asText(take))
      .then(() => notifications.show({ color: "gray", message: "Take details copied." }))
      .catch(() =>
        notifications.show({ color: "red", message: "The browser blocked clipboard access." }),
      );
  }

  if (rows.length === 0) {
    return (
      <SectionCard title="Takes" icon={<IconMusic size={14} />}>
        <EmptyState
          icon={<IconMusic size={26} />}
          title="Nothing rendered yet"
          hint="Every take is saved with the parameters that made it, so a good one can be rendered again later."
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Takes"
      icon={<IconMusic size={14} />}
      actions={
        <Text size="xs" c="dimmed" className="app-mono">
          {rows.length} · {totalMB} MB
        </Text>
      }
      flush
    >
      {/* A plain block scroller, not ScrollArea.Autosize: that component's
          content element sizes to its children (measured 579px inside a 440px
          viewport), so a nowrap title never reaches an ellipsis — it just grows
          the row until the buttons on the right are off-card and the list
          scrolls sideways. A block box takes its width from the card, which is
          what makes the truncation work. */}
      <Box p={8} mah={760} style={{ overflowY: "auto", overflowX: "hidden" }}>
        <Stack gap="xs">
          {rows.map((take, i) => {
            const rt = realtime(take);
            const wall = seconds(take.timing?.wall_ms);
            const expanded = open[take.id] ?? false;
            return (
              <div key={take.id}>
                {i > 0 && <Divider mb="xs" />}
                <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
                  {/* flex:1 + minWidth:0 is what lets a long caption-derived title
                      shrink and ellipsize. Without minWidth:0 a flex item refuses
                      to go below its content width, and the buttons on the right
                      get pushed out of the card entirely. */}
                  <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      size="sm"
                      fw={500}
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {take.title || "Untitled"}
                    </Text>
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                      <Badge size="xs" variant="light">
                        seed {take.seed}
                      </Badge>
                      <Text
                        size="xs"
                        c="dimmed"
                        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {duration(take.durationSec)} · {Math.round(take.sizeBytes / 1024 / 1024)} MB
                        {take.spec.bpm ? ` · ${take.spec.bpm} BPM` : ""}
                        {take.spec.keyscale ? ` · ${take.spec.keyscale}` : ""}
                      </Text>
                    </Group>
                    <Text
                      size="xs"
                      c="dimmed"
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {variant(take.model)}
                      {take.spec.steps ? ` · ${take.spec.steps} steps` : ""}
                      {wall ? ` · rendered in ${wall}` : ""}
                      {rt ? ` · ${rt}` : ""}
                    </Text>
                  </Stack>
                  <Group gap={2} wrap="nowrap">
                    <Tooltip label="Load these settings and this seed" withArrow>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        onClick={() => onReuse(take, "reproduce")}
                        aria-label="Reproduce this take"
                      >
                        <IconRepeat size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Load these settings with a new seed" withArrow>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        onClick={() => onReuse(take, "vary")}
                        aria-label="Vary this take"
                      >
                        <IconArrowsShuffle size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Copy settings, caption and lyrics" withArrow>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        onClick={() => copy(take)}
                        aria-label="Copy take details"
                      >
                        <IconCopy size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Anchor
                      href={api.musicTakeAudioUrl(take.id)}
                      download={`${take.title || take.id}.wav`}
                    >
                      <ActionIcon variant="subtle" size="sm" component="span" aria-label="Download">
                        <IconDownload size={16} />
                      </ActionIcon>
                    </Anchor>
                    <Tooltip label="Delete this take" withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        onClick={() => remove(take)}
                        aria-label="Delete this take"
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>

                <Box mt={4}>
                  {/* sizeBytes lets the player decline to decode a waveform for
                      a full-length take (a 3-minute stereo render is ~33 MB) and
                      fall back to the plain seek bar — see lib/peaks.ts. */}
                  <AudioPlayer
                    src={api.musicTakeAudioUrl(take.id)}
                    sizeBytes={take.sizeBytes}
                    durationSec={take.durationSec}
                    actions={
                      /* The title is the caption truncated, so the full prompt
                         is the one thing the row cannot show and the one thing
                         you need to judge a take against what you asked for. */
                      <Tooltip label={expanded ? "Hide prompt" : "Show prompt"} withArrow>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          onClick={() => setOpen((o) => ({ ...o, [take.id]: !expanded }))}
                          aria-label={expanded ? "Hide prompt" : "Show prompt"}
                        >
                          {expanded ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
                        </ActionIcon>
                      </Tooltip>
                    }
                  />
                </Box>

                <Collapse expanded={expanded}>
                  <Stack gap={4} mt={6} pl={4}>
                    <Text size="xs" c="dimmed" fw={600}>
                      Caption
                    </Text>
                    <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
                      {take.spec.caption}
                    </Text>
                    {take.spec.lyrics?.trim() && (
                      <>
                        <Text size="xs" c="dimmed" fw={600} mt={4}>
                          Lyrics
                        </Text>
                        <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
                          {take.spec.lyrics.trim()}
                        </Text>
                      </>
                    )}
                  </Stack>
                </Collapse>
              </div>
            );
          })}
        </Stack>
      </Box>
    </SectionCard>
  );
}
