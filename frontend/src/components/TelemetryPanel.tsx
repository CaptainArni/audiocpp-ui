import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconFlame, IconInfoCircle } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type { Telemetry } from "../types";

const KIND_COLOR: Record<string, string> = {
  tts: "grape",
  asr: "blue",
  ocr: "teal",
  chat: "violet",
  call: "cyan",
};

/** OCR runs on a separate llama.cpp server, and "voice call" is a pipeline
 *  rather than a model — neither can be unloaded from here. */
const UNLOADABLE = new Set(["tts", "asr"]);

function fmtMs(ms?: number): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function fmtAgo(at?: number): string {
  if (!at) return "—";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function TelemetryPanel() {
  const [tel, setTel] = useState<Telemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unloading, setUnloading] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .getTelemetry()
        .then((t) => alive && (setTel(t), setError(null)))
        .catch((e) => alive && setError((e as Error).message));
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const server = tel?.server;
  const models = tel?.metrics.models ?? [];
  const events = tel?.metrics.events ?? [];
  const warmCount = models.filter((m) => m.warmed && UNLOADABLE.has(m.kind)).length;

  // Models load lazily and are then held forever, which is the right default
  // for latency and the wrong one for a box that also runs a large chat model.
  // Reloading is transparent, so this only costs the next request its load time.
  const unload = async (ids?: string[]) => {
    setUnloading(ids?.[0] ?? "*");
    try {
      const res = await api.unloadModels(ids);
      notifications.show({
        color: "teal",
        message: res.unloaded.length
          ? `Freed ${res.unloaded.length} model${res.unloaded.length === 1 ? "" : "s"}: ${res.unloaded.join(", ")}`
          : "Nothing was loaded.",
      });
      setTel(await api.getTelemetry());
    } catch (e) {
      notifications.show({ color: "red", title: "Could not unload", message: (e as Error).message });
    } finally {
      setUnloading(null);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between">
          <Title order={5}>Inference server</Title>
          <Badge
            size="lg"
            variant={server?.state === "running" ? "filled" : "light"}
            color={
              server?.state === "running"
                ? "green"
                : server?.state === "starting"
                  ? "yellow"
                  : server?.state === "error"
                    ? "red"
                    : "gray"
            }
          >
            {server?.state ?? "…"}
          </Badge>
        </Group>
        {error && (
          <Alert color="red" variant="light" mt="sm">
            {error}
          </Alert>
        )}
        {server && (
          <Group gap="lg" mt="sm">
            <Stat label="Device" value={`GPU ${server.device}`} />
            <Stat label="PID" value={server.pid ? String(server.pid) : "—"} />
            <Stat label="Registered" value={String(server.includedModelIds.length)} />
            <Stat label="Healthy models" value={String(server.healthModels)} />
          </Group>
        )}
        {server?.lastError && (
          <Alert color="red" variant="light" mt="sm" title="Last server error">
            {server.lastError}
          </Alert>
        )}
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Title order={5}>Models</Title>
          <Tooltip
            label={
              warmCount
                ? `Unload ${warmCount} loaded model${warmCount === 1 ? "" : "s"}. They reload automatically on the next request.`
                : "Unload any loaded models. They reload automatically on the next request."
            }
          >
            <Button
              size="xs"
              variant="light"
              color="orange"
              leftSection={<IconFlame size={14} />}
              onClick={() => unload()}
              loading={unloading === "*"}
              // Only gated on the server being up. `warmed` is a proxy — it
              // covers what *this* backend has served — so disabling on a zero
              // count would sometimes refuse to free VRAM that really is held.
              // The response says "Nothing was loaded" when there is nothing.
              disabled={server?.state !== "running"}
            >
              Free VRAM
            </Button>
          </Tooltip>
        </Group>
        {models.length === 0 ? (
          <Alert icon={<IconInfoCircle size={18} />} color="gray" variant="light">
            No activity yet. Generate speech, transcribe audio, or run OCR and per-model throughput shows up here.
            "Warm" means the model has served a request since the server last started (a proxy for loaded in VRAM).
          </Alert>
        ) : (
          <Table.ScrollContainer minWidth={520}>
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Model</Table.Th>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>State</Table.Th>
                  <Table.Th>Requests</Table.Th>
                  <Table.Th>Last time</Table.Th>
                  <Table.Th>Throughput</Table.Th>
                  <Table.Th>When</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {models.map((m) => (
                  <Table.Tr key={m.model}>
                    <Table.Td>
                      <Text size="sm" style={{ wordBreak: "break-all" }}>
                        {m.model}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={KIND_COLOR[m.kind] ?? "gray"} size="sm">
                        {m.kind}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant={m.warmed ? "filled" : "light"} color={m.warmed ? "orange" : "gray"} size="sm">
                        {m.warmed ? "warm" : "cold"}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{m.count}</Table.Td>
                    <Table.Td>{fmtMs(m.lastMs)}</Table.Td>
                    <Table.Td>
                      {m.lastThroughput != null ? `${m.lastThroughput} ${m.throughputUnit ?? ""}` : "—"}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {fmtAgo(m.lastAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {m.warmed && UNLOADABLE.has(m.kind) && (
                        <Tooltip label={`Unload ${m.model} from VRAM`}>
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="orange"
                            loading={unloading === m.model}
                            onClick={() => unload([m.model])}
                          >
                            <IconFlame size={14} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={5} mb="sm">
          Recent generations
        </Title>
        {events.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing yet.
          </Text>
        ) : (
          <ScrollArea.Autosize mah={320} type="auto">
            <Stack gap={6}>
              {events.map((e, i) => (
                <Group key={i} gap="xs" wrap="nowrap" justify="space-between">
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                    <Badge variant="light" color={KIND_COLOR[e.kind] ?? "gray"} size="xs">
                      {e.kind}
                    </Badge>
                    <Text size="xs" truncate style={{ maxWidth: 260 }}>
                      {e.model}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {e.detail}
                    </Text>
                  </Group>
                  <Group gap="sm" wrap="nowrap">
                    {e.throughput != null && (
                      <Text size="xs" c="teal">
                        {e.throughput} {e.unit}
                      </Text>
                    )}
                    <Text size="xs" c="dimmed">
                      {fmtMs(e.ms)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {fmtAgo(e.at)}
                    </Text>
                  </Group>
                </Group>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        )}
      </Paper>
    </Stack>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value}
      </Text>
    </div>
  );
}
