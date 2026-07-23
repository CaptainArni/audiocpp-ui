import { useEffect, useState } from "react";
import { Alert, Badge, Group, Paper, ScrollArea, Stack, Table, Text, Title } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { api } from "../api";
import type { Telemetry } from "../types";

const KIND_COLOR: Record<string, string> = { tts: "grape", asr: "blue", ocr: "teal" };

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
        <Title order={5} mb="sm">
          Models
        </Title>
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
